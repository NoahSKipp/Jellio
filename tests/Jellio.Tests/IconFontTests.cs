using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class IconFontTests
{
    [Fact]
    public void FindsJellyfinWebsMaterialIconsFont()
    {
        var dir = Path.Combine(Path.GetTempPath(), "jellio-web-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "assets"));
        try
        {
            File.WriteAllText(Path.Combine(dir, "assets", "other.woff2"), string.Empty);
            File.WriteAllText(Path.Combine(dir, "MaterialIcons-Regular.2d8017489da689caedc1.woff2"), string.Empty);

            Assert.Equal("MaterialIcons-Regular.2d8017489da689caedc1.woff2", IndexHtmlPatchService.FindIconFont(dir));
            Assert.Null(IndexHtmlPatchService.FindIconFont(Path.Combine(dir, "missing")));
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }
}
