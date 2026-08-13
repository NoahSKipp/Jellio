using MediaBrowser.Model.Plugins;

namespace Jellio.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Master switch. Disabling this restores the stock web client on next start.</summary>
    public bool EnableReskin { get; set; } = true;
}
