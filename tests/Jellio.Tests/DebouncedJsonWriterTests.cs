using System;
using System.IO;
using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class DebouncedJsonWriterTests
{
    [Fact]
    public void ManyChangesWriteTheLatestSnapshotOnce()
    {
        var gate = new object();
        var path = Path.Combine(Path.GetTempPath(), "jellio-writer-" + Guid.NewGuid().ToString("N") + ".json");
        var value = 0;
        var serialized = 0;
        using var writer = new DebouncedJsonWriter(gate, () => path, () => { serialized++; return value.ToString(); }, TimeSpan.FromHours(1));

        lock (gate)
        {
            for (var i = 1; i <= 50; i++)
            {
                value = i;
                writer.Schedule();
            }
        }

        Assert.False(File.Exists(path));
        writer.Flush();
        writer.Flush();

        Assert.Equal("50", File.ReadAllText(path));
        Assert.Equal(1, serialized);
        File.Delete(path);
    }
}
