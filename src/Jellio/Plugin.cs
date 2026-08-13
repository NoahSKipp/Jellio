using Jellio.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellio;

public class JellioPlugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public JellioPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static JellioPlugin? Instance { get; private set; }

    public override string Name => "Jellio";

    public override Guid Id => Guid.Parse("f2937f08-0595-40d1-a74b-a44656cbc6de");

    public override string Description =>
        "Replaces the Jellyfin web client's own rendering with a Nuvio lookalike.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        var prefix = GetType().Namespace;
        yield return new PluginPageInfo
        {
            Name = "jellio",
            EnableInMainMenu = true,
            EmbeddedResourcePath = prefix + ".Configuration.config.html",
        };
    }
}
