using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellio.Services.AniSync;

/// <summary>
/// Encrypts per-user Ani-Sync tokens and credentials at rest using AES-256-GCM
/// backed by a server-local 256-bit key stored inside the Jellio plugin config directory.
/// Each ciphertext is authenticated against its userId, service id, and field name (AAD)
/// so encrypted blobs cannot be replayed across users or providers.
/// </summary>
public class AniSyncSecretProtector
{
    private const string VersionPrefix = "v1:";
    private const int KeySizeBytes = 32;
    private const int NonceSizeBytes = 12;
    private const int TagSizeBytes = 16;

    private readonly string _keyPath;
    private readonly ILogger<AniSyncSecretProtector>? _logger;
    private readonly object _keyLock = new();
    private byte[]? _cachedKey;

    public AniSyncSecretProtector(IApplicationPaths applicationPaths, ILogger<AniSyncSecretProtector>? logger = null)
    {
        _keyPath = Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellio", "anisync.key");
        _logger = logger;
    }

    public string? Protect(string? plaintext, Guid userId, string service, string field)
    {
        if (string.IsNullOrEmpty(plaintext))
        {
            return null;
        }

        var key = GetOrCreateKey();
        var nonce = RandomNumberGenerator.GetBytes(NonceSizeBytes);
        var plainBytes = Encoding.UTF8.GetBytes(plaintext);
        var cipherBytes = new byte[plainBytes.Length];
        var tag = new byte[TagSizeBytes];
        var aad = BuildAad(userId, service, field);

        using var aes = new AesGcm(key, TagSizeBytes);
        aes.Encrypt(nonce, plainBytes, cipherBytes, tag, aad);

        var combined = new byte[NonceSizeBytes + TagSizeBytes + cipherBytes.Length];
        Buffer.BlockCopy(nonce, 0, combined, 0, NonceSizeBytes);
        Buffer.BlockCopy(tag, 0, combined, NonceSizeBytes, TagSizeBytes);
        Buffer.BlockCopy(cipherBytes, 0, combined, NonceSizeBytes + TagSizeBytes, cipherBytes.Length);

        return VersionPrefix + Convert.ToBase64String(combined);
    }

    public string? Unprotect(string? protectedValue, Guid userId, string service, string field)
    {
        if (string.IsNullOrWhiteSpace(protectedValue))
        {
            return null;
        }

        if (!protectedValue.StartsWith(VersionPrefix, StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            var combined = Convert.FromBase64String(protectedValue[VersionPrefix.Length..]);
            if (combined.Length < NonceSizeBytes + TagSizeBytes)
            {
                return null;
            }

            var nonce = combined.AsSpan(0, NonceSizeBytes);
            var tag = combined.AsSpan(NonceSizeBytes, TagSizeBytes);
            var cipherBytes = combined.AsSpan(NonceSizeBytes + TagSizeBytes);
            var plainBytes = new byte[cipherBytes.Length];
            var aad = BuildAad(userId, service, field);

            var key = GetOrCreateKey();
            using var aes = new AesGcm(key, TagSizeBytes);
            aes.Decrypt(nonce, cipherBytes, tag, plainBytes, aad);

            return Encoding.UTF8.GetString(plainBytes);
        }
        catch (CryptographicException ex)
        {
            _logger?.LogWarning(ex, "Jellio Ani-Sync: failed to decrypt credential field {Field} for user {UserId}", field, userId);
            return null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    public static string? MaskSecret(string? plaintext)
    {
        if (string.IsNullOrEmpty(plaintext))
        {
            return null;
        }

        var trimmed = plaintext.Trim();
        if (trimmed.Length <= 4)
        {
            return "****";
        }

        return "****" + trimmed[^4..];
    }

    private static byte[] BuildAad(Guid userId, string service, string field) =>
        Encoding.UTF8.GetBytes($"{userId:N}:{service}:{field}");

    private byte[] GetOrCreateKey()
    {
        lock (_keyLock)
        {
            if (_cachedKey != null)
            {
                return _cachedKey;
            }

            var directory = Path.GetDirectoryName(_keyPath)!;
            Directory.CreateDirectory(directory);

            if (File.Exists(_keyPath))
            {
                try
                {
                    var raw = File.ReadAllText(_keyPath).Trim();
                    var existing = Convert.FromBase64String(raw);
                    if (existing.Length == KeySizeBytes)
                    {
                        _cachedKey = existing;
                        return _cachedKey;
                    }
                }
                catch (Exception ex)
                {
                    _logger?.LogWarning(ex, "Jellio Ani-Sync: regenerating corrupted key file at {KeyPath}", _keyPath);
                }
            }

            var created = RandomNumberGenerator.GetBytes(KeySizeBytes);
            var tempPath = _keyPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(tempPath, Convert.ToBase64String(created));

            if (!OperatingSystem.IsWindows())
            {
                try
                {
                    File.SetUnixFileMode(tempPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                }
                catch
                {
                }
            }

            File.Move(tempPath, _keyPath, overwrite: true);
            _cachedKey = created;
            return _cachedKey;
        }
    }
}
