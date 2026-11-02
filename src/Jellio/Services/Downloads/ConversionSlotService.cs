using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellio.Services.Downloads;

public class ConversionSlotService
{
    public const int MaxConcurrent = 2;

    private static readonly TimeSpan LeaseTtl = TimeSpan.FromSeconds(75);

    private readonly object _lock = new();
    private readonly Dictionary<string, Lease> _leases = new();

    public record Status(int Active, int Max, int Yours)
    {
        public bool Available => Active < Max || Yours > 0;
    }

    private sealed class Lease
    {
        public Guid UserId { get; init; }

        public Guid ItemId { get; init; }

        public DateTime ExpiresAt { get; set; }
    }

    public Status GetStatus(Guid userId)
    {
        lock (_lock)
        {
            Prune();
            return StatusFor(userId);
        }
    }

    // A slot id, or null when every slot is taken. Asking again for the
    // same item by the same user gives back the slot they already hold.
    public (string? SlotId, Status Status) TryClaim(Guid userId, Guid itemId)
    {
        lock (_lock)
        {
            Prune();
            var existing = _leases.FirstOrDefault(pair => pair.Value.UserId == userId && pair.Value.ItemId == itemId);
            if (existing.Key is not null)
            {
                existing.Value.ExpiresAt = DateTime.UtcNow + LeaseTtl;
                return (existing.Key, StatusFor(userId));
            }

            if (_leases.Count >= MaxConcurrent)
            {
                return (null, StatusFor(userId));
            }

            var slotId = Guid.NewGuid().ToString("N");
            _leases[slotId] = new Lease { UserId = userId, ItemId = itemId, ExpiresAt = DateTime.UtcNow + LeaseTtl };
            return (slotId, StatusFor(userId));
        }
    }

    // False when the slot has lapsed (the app should ask for one again).
    public bool Heartbeat(string slotId, Guid userId)
    {
        lock (_lock)
        {
            Prune();
            if (!_leases.TryGetValue(slotId, out var lease) || lease.UserId != userId)
            {
                return false;
            }

            lease.ExpiresAt = DateTime.UtcNow + LeaseTtl;
            return true;
        }
    }

    public void Release(string slotId, Guid userId)
    {
        lock (_lock)
        {
            if (_leases.TryGetValue(slotId, out var lease) && lease.UserId == userId)
            {
                _leases.Remove(slotId);
            }
        }
    }

    private Status StatusFor(Guid userId) =>
        new(_leases.Count, MaxConcurrent, _leases.Values.Count(lease => lease.UserId == userId));

    private void Prune()
    {
        var now = DateTime.UtcNow;
        foreach (var slotId in _leases.Where(pair => pair.Value.ExpiresAt <= now).Select(pair => pair.Key).ToList())
        {
            _leases.Remove(slotId);
        }
    }
}
