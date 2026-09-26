using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.Language;

public record TranslationResult(string? Text, string? DetectedSourceLang, string? Error);

public record DictionarySense(string PartOfSpeech, string Language, IReadOnlyList<string> Definitions, IReadOnlyList<string> Examples);

/// <summary>
/// The reader's language tools. Translation goes to DeepL with the
/// admin's key (never sent to the browser; ":fx" keys are DeepL's free
/// tier, which has its own host). Definitions come from Wiktionary's
/// REST API, which covers most languages with English glosses and needs
/// no key. Both are cached in memory so rereading a word costs nothing.
/// </summary>
public partial class LanguageClient(IHttpClientFactory httpClientFactory, ILogger<LanguageClient> logger)
{
    private const int MaxCacheEntries = 4000;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromDays(7);

    private readonly ConcurrentDictionary<string, (DateTime At, TranslationResult Result)> _translations = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (DateTime At, IReadOnlyList<DictionarySense> Senses)> _definitions = new(StringComparer.Ordinal);

    public static bool TranslationConfigured => !string.IsNullOrWhiteSpace(JellioPlugin.Instance?.Configuration.DeepLApiKey);

    public async Task<TranslationResult> TranslateAsync(string text, string targetLang, string? sourceLang, string? context, CancellationToken cancellationToken)
    {
        var apiKey = (JellioPlugin.Instance?.Configuration.DeepLApiKey ?? string.Empty).Trim();
        if (apiKey.Length == 0)
        {
            return new TranslationResult(null, null, "Translation is not set up on this server");
        }

        var target = NormalizeTarget(targetLang);
        var source = string.IsNullOrWhiteSpace(sourceLang) || sourceLang == "auto" ? null : sourceLang.Split('-')[0].ToUpperInvariant();
        var key = string.Join('\u001f', text, target, source, context);
        if (_translations.TryGetValue(key, out var cached) && DateTime.UtcNow - cached.At < CacheTtl)
        {
            return cached.Result;
        }

        var host = apiKey.EndsWith(":fx", StringComparison.Ordinal) ? "https://api-free.deepl.com" : "https://api.deepl.com";
        var payload = new JsonObject
        {
            ["text"] = new JsonArray(text),
            ["target_lang"] = target,
        };
        if (source is not null)
        {
            payload["source_lang"] = source;
        }

        // DeepL uses the surrounding sentence to pick the right sense of a
        // single word without translating it.
        if (!string.IsNullOrWhiteSpace(context))
        {
            payload["context"] = context;
        }

        try
        {
            var client = httpClientFactory.CreateClient(nameof(LanguageClient));
            using var request = new HttpRequestMessage(HttpMethod.Post, host + "/v2/translate");
            request.Headers.TryAddWithoutValidation("Authorization", "DeepL-Auth-Key " + apiKey);
            request.Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: DeepL translate failed, {StatusCode}", response.StatusCode);
                var message = (int)response.StatusCode switch
                {
                    403 => "The DeepL API key was rejected",
                    456 => "The DeepL character quota for this month is used up",
                    429 => "DeepL is rate limiting requests, try again shortly",
                    _ => "DeepL returned " + (int)response.StatusCode,
                };
                return new TranslationResult(null, null, message);
            }

            var first = (JsonNode.Parse(body)?["translations"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault();
            var result = new TranslationResult(
                first?["text"]?.GetValue<string>(),
                first?["detected_source_language"]?.GetValue<string>()?.ToLowerInvariant(),
                null);
            Remember(_translations, key, (DateTime.UtcNow, result));
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: DeepL translate threw");
            return new TranslationResult(null, null, "Could not reach DeepL");
        }
    }

    // GET https://en.wiktionary.org/api/rest_v1/page/definition/{word}:
    // senses grouped by language code, definitions as HTML. Filtered to
    // the book's language when known; a capitalised word that has no
    // entry retries lowercase (sentence-initial words).
    public async Task<IReadOnlyList<DictionarySense>?> DefineAsync(string word, string? lang, CancellationToken cancellationToken)
    {
        var language = string.IsNullOrWhiteSpace(lang) || lang == "auto" ? null : lang.Split('-')[0].ToLowerInvariant();
        var key = word + '\u001f' + language;
        if (_definitions.TryGetValue(key, out var cached) && DateTime.UtcNow - cached.At < CacheTtl)
        {
            return cached.Senses;
        }

        var senses = await FetchDefinitionAsync(word, language, cancellationToken).ConfigureAwait(false);
        var lower = word.ToLowerInvariant();
        if (senses is { Count: 0 } && lower != word)
        {
            senses = await FetchDefinitionAsync(lower, language, cancellationToken).ConfigureAwait(false);
        }

        if (senses is not null)
        {
            Remember(_definitions, key, (DateTime.UtcNow, senses));
        }

        return senses;
    }

    private async Task<IReadOnlyList<DictionarySense>?> FetchDefinitionAsync(string word, string? language, CancellationToken cancellationToken)
    {
        try
        {
            var client = httpClientFactory.CreateClient(nameof(LanguageClient));
            var url = "https://en.wiktionary.org/api/rest_v1/page/definition/" + Uri.EscapeDataString(word.Replace(' ', '_'));
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            // Wikimedia's API policy asks every client to identify itself.
            request.Headers.TryAddWithoutValidation("User-Agent", "Jellio/1.0 (Jellyfin plugin; https://github.com/NoahSKipp/Jellio)");
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                return [];
            }

            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Jellio: Wiktionary lookup failed, {StatusCode}", response.StatusCode);
                return null;
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (JsonNode.Parse(body) is not JsonObject byLanguage)
            {
                return [];
            }

            var senses = new List<DictionarySense>();
            foreach (var (code, entries) in byLanguage)
            {
                if (language is not null && !string.Equals(code, language, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                foreach (var entry in (entries as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                {
                    var definitions = new List<string>();
                    var examples = new List<string>();
                    foreach (var definition in (entry["definitions"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    {
                        var text = PlainText(definition["definition"]?.GetValue<string>());
                        if (text.Length > 0)
                        {
                            definitions.Add(text);
                        }

                        foreach (var example in (definition["examples"] as JsonArray ?? new JsonArray()).Take(1))
                        {
                            var exampleText = PlainText(example?.GetValue<string>());
                            if (exampleText.Length > 0 && examples.Count < 3)
                            {
                                examples.Add(exampleText);
                            }
                        }
                    }

                    if (definitions.Count > 0)
                    {
                        senses.Add(new DictionarySense(
                            entry["partOfSpeech"]?.GetValue<string>() ?? string.Empty,
                            entry["language"]?.GetValue<string>() ?? code,
                            definitions.Take(6).ToList(),
                            examples));
                    }
                }
            }

            return senses.Take(8).ToList();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jellio: Wiktionary lookup threw for {Word}", word);
            return null;
        }
    }

    // DeepL wants a regional variant for English and Portuguese targets.
    private static string NormalizeTarget(string targetLang)
    {
        var target = targetLang.Trim().ToUpperInvariant();
        return target switch
        {
            "EN" => "EN-US",
            "PT" => "PT-PT",
            _ => target,
        };
    }

    private static string PlainText(string? html)
    {
        if (string.IsNullOrWhiteSpace(html))
        {
            return string.Empty;
        }

        var text = WebUtility.HtmlDecode(TagPattern().Replace(html, string.Empty));
        return WhitespacePattern().Replace(text, " ").Trim();
    }

    private static void Remember<T>(ConcurrentDictionary<string, T> cache, string key, T value)
    {
        if (cache.Count >= MaxCacheEntries)
        {
            cache.Clear();
        }

        cache[key] = value;
    }

    [GeneratedRegex("<[^>]+>")]
    private static partial Regex TagPattern();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespacePattern();
}
