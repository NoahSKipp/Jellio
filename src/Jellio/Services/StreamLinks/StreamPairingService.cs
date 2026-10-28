using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Security.Cryptography;

namespace Jellio.Services.StreamLinks;

public sealed class StreamPairing
{
    public string Code { get; init; } = string.Empty;

    public Guid OwnerId { get; init; }

    public DateTime ExpiresAt { get; init; }

    public string? LinkId { get; set; }

    public string? LinkName { get; set; }
}

// Short codes a TV shows as a QR code: whoever opens it can send links to
// that TV's user until it expires a few minutes later. In memory only.
public class StreamPairingService
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);
    private const string Alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    private const int CodeLength = 6;
    private const int MaxCodesPerUser = 5;
    private const int MaxFailuresPerClient = 20;
    private static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, StreamPairing> _pairings = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, (DateTime Since, int Count)> _failures = new();
    private readonly Func<DateTime> _now;

    public StreamPairingService()
        : this(() => DateTime.UtcNow)
    {
    }

    public StreamPairingService(Func<DateTime> now)
    {
        _now = now;
    }

    public StreamPairing Create(Guid ownerId)
    {
        Sweep();
        foreach (var old in _pairings.Values.Where(p => p.OwnerId == ownerId).OrderBy(p => p.ExpiresAt).SkipLast(MaxCodesPerUser - 1))
        {
            _pairings.TryRemove(old.Code, out _);
        }

        while (true)
        {
            var code = string.Concat(Enumerable.Range(0, CodeLength).Select(_ => Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)]));
            var pairing = new StreamPairing { Code = code, OwnerId = ownerId, ExpiresAt = _now() + Lifetime };
            if (_pairings.TryAdd(code, pairing))
            {
                return pairing;
            }
        }
    }

    // For the owner's own TV, which polls until a link arrives.
    public StreamPairing? Status(Guid ownerId, string code) =>
        _pairings.TryGetValue(Normalize(code), out var pairing) && pairing.OwnerId == ownerId && pairing.ExpiresAt > _now() ? pairing : null;

    // For the phone. False also when this client has guessed too often.
    public bool TryOpen(string code, string client, out StreamPairing pairing)
    {
        pairing = null!;
        if (IsThrottled(client))
        {
            return false;
        }

        if (_pairings.TryGetValue(Normalize(code), out var found) && found.ExpiresAt > _now())
        {
            pairing = found;
            return true;
        }

        _failures.AddOrUpdate(
            client,
            _ => (_now(), 1),
            (_, current) => _now() - current.Since > FailureWindow ? (_now(), 1) : (current.Since, current.Count + 1));
        return false;
    }

    public bool IsThrottled(string client) =>
        _failures.TryGetValue(client, out var record) && _now() - record.Since <= FailureWindow && record.Count >= MaxFailuresPerClient;

    public void Complete(StreamPairing pairing, StreamLink link)
    {
        pairing.LinkId = link.Id;
        pairing.LinkName = link.Name;
    }

    public static string Normalize(string code) =>
        new string((code ?? string.Empty).Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();

    private void Sweep()
    {
        var now = _now();
        foreach (var pairing in _pairings.Values.Where(p => p.ExpiresAt <= now))
        {
            _pairings.TryRemove(pairing.Code, out _);
        }

        foreach (var entry in _failures.Where(f => now - f.Value.Since > FailureWindow))
        {
            _failures.TryRemove(entry.Key, out _);
        }
    }
}
