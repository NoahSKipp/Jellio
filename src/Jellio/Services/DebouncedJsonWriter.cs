using System;
using System.IO;
using System.Threading;

namespace Jellio.Services;

// Coalesces writes of a large state file: callers change their in-memory
// copy under their own lock and call Schedule; the file is rewritten at most
// once per delay, atomically, from a snapshot taken under that same lock.
public sealed class DebouncedJsonWriter : IDisposable
{
    private readonly object _gate;
    private readonly Func<string> _path;
    private readonly Func<string> _serialize;
    private readonly TimeSpan _delay;
    private readonly object _writeLock = new();
    private readonly Timer _timer;
    private bool _pending;

    public DebouncedJsonWriter(object gate, Func<string> path, Func<string> serialize, TimeSpan delay)
    {
        _gate = gate;
        _path = path;
        _serialize = serialize;
        _delay = delay;
        _timer = new Timer(_ => Flush(), null, Timeout.Infinite, Timeout.Infinite);
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Flush();
    }

    // Call while holding the gate.
    public void Schedule()
    {
        if (_pending)
        {
            return;
        }

        _pending = true;
        _timer.Change(_delay, Timeout.InfiniteTimeSpan);
    }

    public void Flush()
    {
        lock (_writeLock)
        {
            string json;
            string path;
            lock (_gate)
            {
                if (!_pending)
                {
                    return;
                }

                _pending = false;
                json = _serialize();
                path = _path();
            }

            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temp = path + ".tmp";
            File.WriteAllText(temp, json);
            File.Move(temp, path, true);
        }
    }

    public void Dispose()
    {
        Flush();
        _timer.Dispose();
    }
}
