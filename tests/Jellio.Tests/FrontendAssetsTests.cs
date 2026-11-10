using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class FrontendAssetsTests
{
    [Fact]
    public void StartupModulesFollowStaticImportsOnly()
    {
        var modules = FrontendAssets.StartupModules();

        Assert.Contains("runtime/api.js", modules);
        Assert.Contains("runtime/i18n.js", modules);
        Assert.DoesNotContain("app.js", modules);
        Assert.DoesNotContain("screens/player.js", modules);
        Assert.DoesNotContain("runtime/changelog.js", modules);
        Assert.DoesNotContain("runtime/strings-de.js", modules);
    }

    [Theory]
    [InlineData("components/seasons.js")]
    [InlineData("components/audioMiniPlayer.js")]
    [InlineData("components/onboardingModal.js")]
    [InlineData("runtime/syncPlay.js")]
    [InlineData("components/streamPicker.js")]
    [InlineData("components/downloads.js")]
    [InlineData("components/readerStudy.js")]
    public void StartupModulesLeaveOutModulesLoadedOnFirstUse(string module)
    {
        Assert.DoesNotContain(module, FrontendAssets.StartupModules());
    }

    [Fact]
    public void MinifiedCssDropsCommentsAndIndentation()
    {
        var css = "/* header */\n.a {\n  color: red; /* why */\n}\n\n\n.b { margin: 0 }\n";

        Assert.Equal(".a {\ncolor: red;\n}\n.b { margin: 0 }\n", FrontendAssets.MinifyCss(css));
    }

    [Fact]
    public void ServedCssIsMinified()
    {
        var css = System.Text.Encoding.UTF8.GetString(FrontendAssets.Read("css/app.css")!);

        Assert.DoesNotContain("/*", css);
        Assert.Contains(".jellio-party-card", css);
    }
}
