using Jellio.Services;
using Xunit;

namespace Jellio.Tests;

public class LanguagePreloadTests
{
    [Fact]
    public void PreloadsTheStoredLanguageTableWithTheVersionKey()
    {
        var script = IndexHtmlPatchService.BuildLanguagePreloadScript("1.2.3.4");

        Assert.Contains("localStorage.getItem('jellio_display_language')", script);
        Assert.Contains("\"de\"", script);
        Assert.Contains("\"pt\"", script);
        Assert.DoesNotContain("\"en\"", script);
        Assert.Contains("link.rel = 'modulepreload'", script);
        Assert.Contains("'/Jellio/frontend/runtime/strings-' + lang + '.js?v=1.2.3.4'", script);
    }
}
