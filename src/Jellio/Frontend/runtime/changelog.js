// What's New changelog definitions and tracking for Jellio Web.
// Updated on releases so users can inspect release notes in Settings -> About,
// while notifications are restricted strictly to big releases (1.4X.0) so users
// are not alerted on small patch releases.
import { getCurrentUserId } from './auth.js';

export function isBigRelease(version) {
  if (!version || typeof version !== 'string') return false;
  const clean = version.trim().replace(/^v/i, '');
  const parts = clean.split('.');
  if (parts.length >= 3) {
    const patch = parseInt(parts[2], 10);
    const build = parts.length > 3 ? parseInt(parts[3], 10) : 0;
    return !isNaN(patch) && patch === 0 && (!build || build === 0);
  }
  if (parts.length === 2) return true;
  return false;
}

export const CHANGELOG_RELEASES = [
  {
    "version": "1.87.5",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.87.5",
    "summary": "Comprehensive Settings translations and cross-device onboarding sync.",
    "highlights": [
      {
        "title": "Complete Settings Localization",
        "description": "Translates all remaining Settings cards, form fields, action buttons, status messages, recommendation controls, and category headers across all supported languages."
      },
      {
        "title": "Cross-Device Onboarding Synchronization",
        "description": "Persists onboarding status to server display preferences so accounts that completed or configured preferences never see the setup wizard repeatedly on other devices."
      },
      {
        "title": "Localized Greetings & Recommendations",
        "description": "Translates home greetings (Good morning, Still up?) and dynamic recommendation headers (Top Picks for You, Because you watched)."
      }
    ]
  },
  {
    "version": "1.87.4",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.87.4",
    "summary": "Full multi-language UI translation and localized Jellyfin metadata fetching.",
    "highlights": [
      {
        "title": "Comprehensive UI Localization",
        "description": "Translates all Jellio interface elements across the sidebar, navigation, home row titles, detail action buttons, card context menus, search, login, and settings into all supported display languages (English, German, Spanish, Polish, French, Italian, and Portuguese)."
      },
      {
        "title": "Localized Metadata & Culture Querying",
        "description": "Requests item titles, series descriptions, and overviews in the active display language from the Jellyfin server with automatic fallback to English when translations are unavailable."
      },
      {
        "title": "Language-Segmented Row Caching",
        "description": "Partitions offline row and item caches by active display language and automatically refreshes cached rows when switching languages so stale translations are never shown."
      }
    ]
  },
  {
    "version": "1.87.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.87.3",
    "summary": "Fix dropdown option contrast in audio and subtitle selection.",
    "highlights": [
      {
        "title": "Dropdown Dark Mode",
        "description": "Fixes an issue where audio and subtitle language dropdown options rendered white text on a white background by enforcing dark mode popups and high-contrast option styling."
      }
    ]
  },
  {
    "version": "1.87.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.87.2",
    "summary": "Do not prompt onboarding for established users with existing settings.",
    "highlights": [
      {
        "title": "Onboarding Polishing",
        "description": "Ensures the first-run onboarding setup wizard is strictly reserved for clean installs and does not prompt established users who already configured their preferences."
      }
    ]
  },
  {
    "version": "1.87.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.87.1",
    "summary": "Fix overlay mounting and session recovery on Jellyfin Web.",
    "highlights": [
      {
        "title": "Overlay Restoration",
        "description": "Fixes a module export resolution error that prevented Jellio from mounting its overlay over Jellyfin Web on startup."
      },
      {
        "title": "Reliable Session Recovery",
        "description": "Seamlessly restores active Jellyfin Web credentials from storage on startup without relying solely on console log interception."
      }
    ]
  },
  {
    "version": "1.87.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.87.0",
    "summary": "Guided setup wizard, new display languages, and cross-platform preference sync.",
    "highlights": [
      {
        "title": "Setup Wizard",
        "description": "A guided onboarding flow helps you configure your display language, audio and subtitle defaults, and reader preferences right from the start. You can also re-run the wizard at any time from Settings > About."
      },
      {
        "title": "Display Languages",
        "description": "Full interface localization is now available in English, German (Deutsch), Spanish (Español), French (Français), Italian (Italiano), Polish (Polski), and Portuguese (Português). Choosing a language also updates media descriptions to match your preference."
      },
      {
        "title": "Cross-Platform Preference Sync",
        "description": "Playback preferences configured on Jellio TV are automatically detected so you never have to re-enter them on Web."
      }
    ]
  },
  {
    "version": "1.86.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.86.3",
    "summary": "The Studio Hub glow sits behind the logo.",
    "highlights": [
      {
        "title": "Centred Hub Glow",
        "description": "The coloured glow in a Studio Hub's header is now centred behind the service's logo instead of off to its side, and radiates out further."
      }
    ]
  },
  {
    "version": "1.86.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.86.2",
    "summary": "Jellyfin's device list shows the right Jellio version.",
    "highlights": [
      {
        "title": "Correct Version in Jellyfin",
        "description": "Jellyfin's Devices and Dashboard now show the Jellio version you're running instead of 0.1.0. The Mac app shows up as Jellio for macOS with its own version."
      }
    ]
  },
  {
    "version": "1.86.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.86.1",
    "summary": "No more Skip Credits and Next Episode right as an episode starts.",
    "highlights": [
      {
        "title": "Skip Prompts at the Right Time",
        "description": "Episodes with an \"Opening Credits\" chapter, or bad credits timestamps, showed Skip Intro, Skip Credits and Next Episode all at once as they began. Credits now only count in the second half of an episode."
      }
    ]
  },
  {
    "version": "1.86.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.86.0",
    "summary": "A calmer sidebar and quicker, more colourful Studio Hubs.",
    "highlights": [
      {
        "title": "One-Tone Sidebar",
        "description": "The sidebar now uses the same colour as the page, like Jellio TV, and only lifts off with a shadow while it's open."
      },
      {
        "title": "Studio Hubs in Their Colours",
        "description": "Each Studio Hub's header is tinted in the service's own colour, from Netflix red to Crunchyroll orange."
      },
      {
        "title": "Faster Studio Hubs",
        "description": "Hub rows show up one by one as soon as each catalog answers, instead of the whole page waiting for the slowest one."
      },
      {
        "title": "Smoother Transitions",
        "description": "Backdrops on title pages and Studio Hubs fade in instead of popping in, and the Home hero's title and description fade between slides. Set Motion to Still or Off in Settings > Display to turn them off."
      }
    ]
  },
  {
    "version": "1.85.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.85.0",
    "summary": "Anime stays out of your other rows, and every Studio Hub has its logo.",
    "highlights": [
      {
        "title": "Anime Stays in Anime",
        "description": "Anime is now recognised much more reliably: anything from an anime catalog, with an anime database id, an Anime genre or made as animation in Japan. It no longer turns up in Home, Movies and Series. Update Gelato too, and run its Tag anime task once (it also runs on its own at startup)."
      },
      {
        "title": "More Studio Hub Logos",
        "description": "AMC+, Shudder, Discovery+ and Sky Go now show their logos instead of their name, on the web and on Jellio TV."
      }
    ]
  },
  {
    "version": "1.84.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.84.2",
    "summary": "A leftover Up Next setting is gone.",
    "highlights": [
      {
        "title": "Simpler Up Next Settings",
        "description": "The Up Next display timing setting is removed. Up Next appears when the credits start, and only for episodes with credits timestamps, so the setting no longer did anything."
      }
    ]
  },
  {
    "version": "1.84.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.84.0",
    "summary": "Skip Intro and Skip Credits now find timestamps for more shows.",
    "highlights": [
      {
        "title": "More Skip Intro Coverage",
        "description": "Jellio now uses the newest version of TheIntroDB, the community database behind Skip Intro and Skip Credits. More shows and movies have timestamps, and titles that only had a TVDB or IMDb id are now covered too."
      },
      {
        "title": "Right Episode, Any Order",
        "description": "Shows set to DVD, absolute or another episode order in Jellyfin now get the skip times for the episode you are actually watching."
      }
    ]
  },
  {
    "version": "1.83.14",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.14",
    "summary": "Genre rows show each title once and include descriptions.",
    "highlights": [
      {
        "title": "No More Duplicate Titles",
        "description": "Genre rows no longer show the same movie or show more than once, so every row is filled with different titles."
      },
      {
        "title": "Descriptions in Genre Rows",
        "description": "Titles in genre rows now come with their description, so it shows up right away when you browse them."
      }
    ]
  },
  {
    "version": "1.83.13",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.13",
    "summary": "Playback works again, and streams wrongly flagged as broken during the outage are trusted again.",
    "highlights": [
      {
        "title": "Streams Play Again",
        "description": "A stalled stream cache on the server made every stream time out, so Jellio cycled through all of them and reported that none worked. The cache is fixed and now restarts itself if it ever stalls, and stream lists no longer fill up with expired links."
      },
      {
        "title": "Forgiving Stream Health",
        "description": "Streams marked as broken during the outage are cleared. A stream that only times out is now remembered for two hours instead of two days, and only that exact stream is skipped, never other copies of the same release."
      }
    ]
  },
  {
    "version": "1.83.11",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.11",
    "summary": "Fix stream negotiation failover, restore transcode fallback retry, and repair failover Stop button cancellation.",
    "highlights": [
      {
        "title": "Resilient Stream Playback & Failover",
        "description": "Probing and negotiation timeouts no longer falsely mark streams as bad or trigger cascading failovers. Restored automatic server remux fallback when direct play fails before the first frame, and user-selected streams are immediately unflagged so they can be replayed."
      },
      {
        "title": "Failover Stop Button Fix",
        "description": "Clicking Stop on the retry overlay now immediately tears down the player and cancels pending negotiations, preventing unwanted retries."
      }
    ]
  },
  {
    "version": "1.83.10",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.10",
    "summary": "Fix genre row items endpoint MissingMethodException on Jellyfin 12 and add resilient DTO mapping fallback.",
    "highlights": [
      {
        "title": "Jellyfin 12 DTO Compatibility",
        "description": "Resolved a binary interface mismatch in IDtoService.GetBaseItemDtos by dynamically adapting to parameter count variations and adding graceful fallback to single-item conversion."
      }
    ]
  },
  {
    "version": "1.83.9",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.9",
    "summary": "Fix syntax error in player module that blocked playback screen rendering.",
    "highlights": [
      {
        "title": "Player Module Syntax Fix",
        "description": "Resolved a duplicate variable declaration in the player screen module that prevented the playback page from loading."
      }
    ]
  },
  {
    "version": "1.83.8",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.8",
    "summary": "Fix stream duplicate accumulation, multi-line release health isolation, and pre-negotiation failover.",
    "highlights": [
      {
        "title": "Scraper Sync Stream Deduplication",
        "description": "Repeated sync clones of the same scraper release are now cleanly deduplicated, keeping the newest synced proxy URL while preserving probed video and audio details."
      },
      {
        "title": "Seamless Stream Failover & Remuxing",
        "description": "Probed Matroska streams now consistently use server-side stream-copy remuxing to avoid static direct-play stalls, the failover overlay displays continuously during negotiation, and failed streams advance immediately to the next candidate."
      }
    ]
  },
  {
    "version": "1.83.7",

    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.7",
    "summary": "Fix stream health keying to isolate bad streams by unique ID and restore Chromium Matroska direct play.",
    "highlights": [
      {
        "title": "Accurate Stream Health Isolation",
        "description": "Failed streams are now keyed strictly by their unique media source ID, preventing a single failed stream from flagging other streams for the same title, and automatically purging legacy poisoned keys."
      },
      {
        "title": "Restored Matroska Direct Play & Smooth Loading",
        "description": "Restored native Matroska container probing for Chromium browsers so compatible streams direct-play without server transcode stalls, and kept loading artwork active until video frames genuinely render."
      }
    ]
  },
  {
    "version": "1.83.6",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.6",
    "summary": "Matroska stream remuxing, loading backdrop persistence, and deferred subtitle extraction fixes.",
    "highlights": [
      {
        "title": "Matroska Remux Playback",
        "description": "Probed MKV streams now consistently use server-side fragmented MP4 remuxing rather than attempting direct Matroska playback in browsers that only support metadata parsing."
      },
      {
        "title": "Persistent Loading Artwork & Deferred Subtitles",
        "description": "The title backdrop and pulsing logo now appear immediately during stream negotiation and stay visible until video frames are ready to play, while embedded subtitle extraction waits until playback starts."
      }
    ]
  },
  {
    "version": "1.83.5",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.5",
    "summary": "Stream failover accuracy and replay reliability fixes for previously played streams.",
    "highlights": [
      {
        "title": "Accurate Bad Stream Tracking",
        "description": "Failed streams are now keyed by their unique source ID and release filename rather than the shared quality tier header, preventing a single failed stream from flagging all streams in that tier."
      },
      {
        "title": "Reliable Replay for Probed Streams",
        "description": "Previously played streams now fall back to server transcoding if direct play fails before the first frame, normalize comma-separated container names, and cap placeholder detection to short clips under 3 minutes."
      }
    ]
  },
  {
    "version": "1.83.4",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.4",
    "summary": "Placeholder stub filtering fix and removal of single-stream auto-pick.",
    "highlights": [
      {
        "title": "Accurate Placeholder Filtering",
        "description": "Unprobed stubs with default Unknown video ranges or sub-megabyte stub sizes are now cleanly recognized as empty and routed to the Digital Release Filter card."
      },
      {
        "title": "Always Show Stream Picker",
        "description": "Removed automatic playback when only a single stream is returned so you can always inspect or refresh the available source first."
      }
    ]
  },
  {
    "version": "1.83.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.3",
    "summary": "Nuvio-style Digital Release Filter card and relaxed single-stub stream detection.",
    "highlights": [
      {
        "title": "Digital Release Filter Card",
        "description": "When no playable streams are found, the stream picker now displays a Digital Release Filter card with refresh and provider controls."
      },
      {
        "title": "Relaxed Stream Detection",
        "description": "Only treats a title as having no streams when a single media source returns with no quality, codec, bitrate, or audio metadata."
      }
    ]
  },
  {
    "version": "1.83.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.2",
    "summary": "Stream resolution improvements and placeholder detection fixes.",
    "highlights": [
      {
        "title": "Stream Detection Refinement",
        "description": "Refined stream detection preserves valid .strm and debrid releases while cleanly filtering placeholder stubs."
      }
    ]
  },
  {
    "version": "1.83.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.83.0",
    "summary": "Community watching performance boost, placeholder stream handling, and customize improvements.",
    "highlights": [
      {
        "title": "Lightning-Fast Community Watching",
        "description": "Multi-tier server caching, parallelized user queries, and background pre-warming make What Others Are Watching load in milliseconds."
      },
      {
        "title": "Placeholder Stream Protection",
        "description": "Unreleased titles and library stubs now cleanly display digital release prompts inside the stream picker instead of attempting to play invalid files."
      },
      {
        "title": "Home Customize Title Cleanup",
        "description": "Row titles in home edit mode now cleanly display row names without trailing chevron symbols."
      }
    ]
  },
  {
    "version": "1.82.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.82.0",
    "summary": "Streaming optimizations and stability improvements.",
    "highlights": [
      {
        "title": "Streaming Optimization",
        "description": "Stream resolution improvements and performance enhancements."
      }
    ]
  },
  {
    "version": "1.81.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.81.0",
    "summary": "Complete version history in About and notification cleanup.",
    "highlights": [
      {
        "title": "Complete Version History",
        "description": "Settings > About now features complete version history across all releases."
      },
      {
        "title": "Notification Cleanup",
        "description": "Stale changelog notifications and dismiss states are automatically cleaned up on major updates."
      }
    ]
  },
  {
    "version": "1.80.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.80.1",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "1.80.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.80.0",
    "summary": "Screen Wake Lock, global media keys, desktop playback sync, and UI performance enhancements.",
    "highlights": [
      {
        "title": "Screen Wake Lock",
        "description": "The video player now keeps your screen awake automatically during playback, even on long scenes without mouse movement."
      },
      {
        "title": "Global Media Keys & Desktop Sync",
        "description": "Control playback using hardware media keys (Play/Pause, Next Track, Previous Track) and seamlessly sync state with the desktop app."
      },
      {
        "title": "Expandable What's New",
        "description": "Settings > About now features cleanly collapsed expandable cards for past release notes."
      },
      {
        "title": "Instant Screen Loading",
        "description": "Secondary screens and modules load dynamically on demand, cutting initial startup and bundle parse time."
      }
    ]
  },
  {
    "version": "1.79.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.79.1",
    "summary": "UI refinements and What's New display improvements.",
    "highlights": [
      {
        "title": "Expandable What's New",
        "description": "What's New in Settings is now cleanly collapsed with an interactive chevron so it never dominates the About page."
      },
      {
        "title": "Instant Screen Loading",
        "description": "Secondary screens and modules are loaded dynamically on demand, cutting initial bundle parse time."
      }
    ]
  },
  {
    "version": "1.79.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.79.0",
    "summary": "New Recommendations row, custom recommendation settings, manga chapter art fallback, and performance optimizations.",
    "highlights": [
      {
        "title": "What Others Are Watching",
        "description": "A new row on your home screen highlights what friends and family on your server are actively streaming or recently finished, complete with viewer avatars."
      },
      {
        "title": "Recommendations Settings",
        "description": "A new dedicated Settings tab lets you manage which users appear in your social watching row, or toggle the row off entirely."
      },
      {
        "title": "Genre Row Customization",
        "description": "Take control of your home feed: select and order your favorite genre rows directly from Recommendations settings."
      },
      {
        "title": "Manga Chapter Cover Fallback",
        "description": "Chapters without individual thumbnails automatically use the overall manga series cover art."
      },
      {
        "title": "Performance & Speed Improvements",
        "description": "Server-side caching for genres and watching activity reduces database load for faster, smoother browsing."
      }
    ]
  },
  {
    "version": "1.78.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.78.0",
    "summary": "Community row ahead of per-title recommendations, drop More with rows",
    "highlights": [
      {
        "title": "Home",
        "description": "Community row ahead of per-title recommendations, drop More with rows"
      }
    ]
  },
  {
    "version": "1.77.8",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.77.8",
    "summary": "Stream recommendation and library rows, restore community row",
    "highlights": [
      {
        "title": "Home",
        "description": "Stream recommendation and library rows, restore community row"
      }
    ]
  },
  {
    "version": "1.77.7",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.77.7",
    "summary": "Build fixes for the genre cache",
    "highlights": [
      {
        "title": "Genres",
        "description": "Build fixes for the genre cache"
      },
      {
        "title": "Home",
        "description": "Never wait on the community row, render every row as it arrives, cache genres on the server"
      }
    ]
  },
  {
    "version": "1.77.6",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.77.6",
    "summary": "Fall back to overall manga series cover when chapter has no image",
    "highlights": [
      {
        "title": "Card",
        "description": "Fall back to overall manga series cover when chapter has no image"
      },
      {
        "title": "Metadata",
        "description": "Fall back to manga series and folder covers when Chaptarr has no cover"
      }
    ]
  },
  {
    "version": "1.77.5",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.77.5",
    "summary": "No lightning while reading, listening or watching",
    "highlights": [
      {
        "title": "Seasonal",
        "description": "No lightning while reading, listening or watching"
      },
      {
        "title": "Manga",
        "description": "Read a chapter's number from its name when the source gives none"
      },
      {
        "title": "Manga",
        "description": "Keep saved chapters from other sources out of a streamed series"
      }
    ]
  },
  {
    "version": "1.77.4",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.77.4",
    "summary": "No placeholder streams for unreleased titles",
    "highlights": [
      {
        "title": "Streams",
        "description": "No placeholder streams for unreleased titles"
      }
    ]
  },
  {
    "version": "1.77.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.77.3",
    "summary": "Look for streams quietly",
    "highlights": [
      {
        "title": "Detail",
        "description": "Look for streams quietly"
      },
      {
        "title": "Detail",
        "description": "Reopen title pages instantly from what was last seen"
      }
    ]
  },
  {
    "version": "1.77.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.77.2",
    "summary": "Show the show's art on episode cards in landscape rows",
    "highlights": [
      {
        "title": "Home",
        "description": "Show the show's art on episode cards in landscape rows"
      },
      {
        "title": "Detail",
        "description": "Load title info without resolving streams"
      },
      {
        "title": "Revert",
        "description": "Keep episode stills on Jellio's own episode cards"
      }
    ]
  },
  {
    "version": "1.77.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.77.1",
    "summary": "Find watched shows from episode history and wait longer for new seasons",
    "highlights": [
      {
        "title": "Calendar",
        "description": "Find watched shows from episode history and wait longer for new seasons"
      }
    ]
  },
  {
    "version": "1.77.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.77.0",
    "summary": "Add a Display category with a seasonal motion level",
    "highlights": [
      {
        "title": "Settings",
        "description": "Add a Display category with a seasonal motion level"
      }
    ]
  },
  {
    "version": "1.76.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.76.0",
    "summary": "Show manga search results source by source",
    "highlights": [
      {
        "title": "Manga",
        "description": "Show manga search results source by source"
      },
      {
        "title": "Manga",
        "description": "Fall back to AniList covers for chapters read from a source"
      },
      {
        "title": "Maintenance",
        "description": "Accept either dotnet test summary format"
      }
    ]
  },
  {
    "version": "1.75.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.75.0",
    "summary": "Persistent row cache shared across tabs",
    "highlights": [
      {
        "title": "Home",
        "description": "Persistent row cache shared across tabs"
      },
      {
        "title": "Home",
        "description": "Refresh rows when coming back, drop rows that are too old"
      },
      {
        "title": "Search",
        "description": "Show library titles first and fill in as results arrive"
      }
    ]
  },
  {
    "version": "1.74.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.74.3",
    "summary": "Ensure google cast compatibility with dedicated mp4 stream and metadata",
    "highlights": [
      {
        "title": "Cast",
        "description": "Ensure google cast compatibility with dedicated mp4 stream and metadata"
      }
    ]
  },
  {
    "version": "1.74.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.74.2",
    "summary": "Isolate sidepanels to prevent mutual reveal and scrolling lockups",
    "highlights": [
      {
        "title": "Player",
        "description": "Isolate sidepanels to prevent mutual reveal and scrolling lockups"
      }
    ]
  },
  {
    "version": "1.74.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.74.1",
    "summary": "Clearer stream badges, HD detection and failover overlay",
    "highlights": [
      {
        "title": "Player",
        "description": "Clearer stream badges, HD detection and failover overlay"
      }
    ]
  },
  {
    "version": "1.74.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.74.0",
    "summary": "Video transcode policy to avoid server-side video re-encodes",
    "highlights": [
      {
        "title": "Player",
        "description": "Video transcode policy to avoid server-side video re-encodes"
      },
      {
        "title": "Player",
        "description": "Judge unprobed streams by their AIOStreams name"
      },
      {
        "title": "Player",
        "description": "Log Jellyfin's transcode reasons and the client"
      },
      {
        "title": "Player",
        "description": "Mark streams that need a video re-encode in the Sources panel"
      }
    ]
  },
  {
    "version": "1.73.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.73.1",
    "summary": "Episode panel shows only the chosen season and opens on the current episode",
    "highlights": [
      {
        "title": "Player",
        "description": "Episode panel shows only the chosen season and opens on the current episode"
      }
    ]
  },
  {
    "version": "1.73.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.73.0",
    "summary": "Try the next stream when one doesn't play",
    "highlights": [
      {
        "title": "Player",
        "description": "Try the next stream when one doesn't play"
      }
    ]
  },
  {
    "version": "1.72.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.72.0",
    "summary": "Adjustable pre-buffer for smoother 4K playback",
    "highlights": [
      {
        "title": "Player",
        "description": "Adjustable pre-buffer for smoother 4K playback"
      }
    ]
  },
  {
    "version": "1.71.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.71.0",
    "summary": "Make the top tier of each badge group harder to reach",
    "highlights": [
      {
        "title": "Achievements",
        "description": "Make the top tier of each badge group harder to reach"
      }
    ]
  },
  {
    "version": "1.70.6",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.70.6",
    "summary": "Recognise Gelato's placeholder by the title's own name",
    "highlights": [
      {
        "title": "Streams",
        "description": "Recognise Gelato's placeholder by the title's own name"
      }
    ]
  },
  {
    "version": "1.70.5",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.70.5",
    "summary": "Keep GIF pictures animated",
    "highlights": [
      {
        "title": "Announcements",
        "description": "Keep GIF pictures animated"
      }
    ]
  },
  {
    "version": "1.70.4",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.70.4",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "1.70.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.70.3",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "1.70.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.70.2",
    "summary": "Say no streams are available instead of offering Gelato's placeholder",
    "highlights": [
      {
        "title": "Streams",
        "description": "Say no streams are available instead of offering Gelato's placeholder"
      }
    ]
  },
  {
    "version": "1.70.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.70.1",
    "summary": "A visible Choose image button, plus paste and drop",
    "highlights": [
      {
        "title": "Announcements",
        "description": "A visible Choose image button, plus paste and drop"
      },
      {
        "title": "Listen",
        "description": "Count listening time toward lifetime stats"
      }
    ]
  },
  {
    "version": "1.70.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.70.0",
    "summary": "Attach a picture to an announcement",
    "highlights": [
      {
        "title": "Announcements",
        "description": "Attach a picture to an announcement"
      }
    ]
  },
  {
    "version": "1.69.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.69.1",
    "summary": "Keep the mini player above the mobile nav and its play icon visible",
    "highlights": [
      {
        "title": "Listen",
        "description": "Keep the mini player above the mobile nav and its play icon visible"
      }
    ]
  },
  {
    "version": "1.69.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.69.0",
    "summary": "Every content type chip always shown, and finished manga series post",
    "highlights": [
      {
        "title": "Feed",
        "description": "Every content type chip always shown, and finished manga series post"
      },
      {
        "title": "Feed",
        "description": "Only post a finished manga series when the series is completed"
      }
    ]
  },
  {
    "version": "1.68.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.68.0",
    "summary": "Show the time a click jumps to when hovering the mini player bar",
    "highlights": [
      {
        "title": "Listen",
        "description": "Show the time a click jumps to when hovering the mini player bar"
      },
      {
        "title": "Listen",
        "description": "Volume controls and hover time preview on both audiobook players"
      }
    ]
  },
  {
    "version": "1.67.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.67.2",
    "summary": "Mini player progress that fills as it plays, and trailers that play",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Mini player progress that fills as it plays, and trailers that play"
      }
    ]
  },
  {
    "version": "1.67.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.67.1",
    "summary": "Visible back-skip button and a single play/pause icon",
    "highlights": [
      {
        "title": "Listen",
        "description": "Visible back-skip button and a single play/pause icon"
      }
    ]
  },
  {
    "version": "1.67.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.67.0",
    "summary": "Send an announcement to one user or to everyone",
    "highlights": [
      {
        "title": "Announcements",
        "description": "Send an announcement to one user or to everyone"
      }
    ]
  },
  {
    "version": "1.66.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.66.1",
    "summary": "Keep the device name plain ASCII so signed-in requests aren't rejected",
    "highlights": [
      {
        "title": "Auth",
        "description": "Keep the device name plain ASCII so signed-in requests aren't rejected"
      }
    ]
  },
  {
    "version": "1.66.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.66.0",
    "summary": "Filter the feed by content type",
    "highlights": [
      {
        "title": "Feed",
        "description": "Filter the feed by content type"
      }
    ]
  },
  {
    "version": "1.65.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.65.0",
    "summary": "Keep anime to the Anime library, and only post finished reading to the feed",
    "highlights": [
      {
        "title": "Feature",
        "description": "Keep anime to the Anime library, and only post finished reading to the feed"
      }
    ]
  },
  {
    "version": "1.64.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.64.0",
    "summary": "Show which kind of device each session plays on",
    "highlights": [
      {
        "title": "Now-playing",
        "description": "Show which kind of device each session plays on"
      },
      {
        "title": "Offline",
        "description": "Recover from a false offline state after leaving the tab"
      }
    ]
  },
  {
    "version": "1.63.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.63.0",
    "summary": "Add a Requests page and per-reader removal for books and audiobooks",
    "highlights": [
      {
        "title": "Books",
        "description": "Add a Requests page and per-reader removal for books and audiobooks"
      },
      {
        "title": "Books",
        "description": "Show Requested and Downloaded instead of Listen for books not in the library yet"
      },
      {
        "title": "Books",
        "description": "Format the requests entry initializer"
      }
    ]
  },
  {
    "version": "1.62.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.62.0",
    "summary": "Add quality filter chips that combine with language chips",
    "highlights": [
      {
        "title": "Streams",
        "description": "Add quality filter chips that combine with language chips"
      }
    ]
  },
  {
    "version": "1.61.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.61.3",
    "summary": "Hoist screenTornDown to top of renderPlayer to resolve TDZ ReferenceError",
    "highlights": [
      {
        "title": "Player",
        "description": "Hoist screenTornDown to top of renderPlayer to resolve TDZ ReferenceError"
      }
    ]
  },
  {
    "version": "1.61.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.61.2",
    "summary": "Encapsulate seasonal query in api.js to avoid unexported imports",
    "highlights": [
      {
        "title": "Seasonal",
        "description": "Encapsulate seasonal query in api.js to avoid unexported imports"
      }
    ]
  },
  {
    "version": "1.61.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.61.1",
    "summary": "Export dedupe function from recommend.js",
    "highlights": [
      {
        "title": "Recommend",
        "description": "Export dedupe function from recommend.js"
      },
      {
        "title": "Maintenance",
        "description": "Add actions write permission to release workflow"
      }
    ]
  },
  {
    "version": "1.61.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.61.0",
    "summary": "Add seasonal recommendations row below Top Picks for You",
    "highlights": [
      {
        "title": "Home",
        "description": "Add seasonal recommendations row below Top Picks for You"
      },
      {
        "title": "Maintenance",
        "description": "Trigger publish plugin workflow automatically on release"
      }
    ]
  },
  {
    "version": "1.60.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.60.3",
    "summary": "Properly teardown wheel, dblclick, and wake listeners on cleanup",
    "highlights": [
      {
        "title": "Player",
        "description": "Properly teardown wheel, dblclick, and wake listeners on cleanup"
      },
      {
        "title": "Player",
        "description": "Remove up next timer from player popover and remove redundant topbar keyboard button"
      }
    ]
  },
  {
    "version": "1.60.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.60.2",
    "summary": "Fix google cast sdk initialization and remote playback in chrome android pwa",
    "highlights": [
      {
        "title": "Cast",
        "description": "Fix google cast sdk initialization and remote playback in chrome android pwa"
      }
    ]
  },
  {
    "version": "1.60.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.60.1",
    "summary": "Fix manga pinch-zoom page jumping and pdf zoom left-side cutoff",
    "highlights": [
      {
        "title": "Reader",
        "description": "Fix manga pinch-zoom page jumping and pdf zoom left-side cutoff"
      }
    ]
  },
  {
    "version": "1.60.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.60.0",
    "summary": "Richer Christmas and New Year effects",
    "highlights": [
      {
        "title": "Feature",
        "description": "Richer Christmas and New Year effects"
      }
    ]
  },
  {
    "version": "1.59.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.59.0",
    "summary": "Take the witch and the drifting skulls out of the Halloween effect",
    "highlights": [
      {
        "title": "Feature",
        "description": "Take the witch and the drifting skulls out of the Halloween effect"
      },
      {
        "title": "Bug Fix",
        "description": "Bring back Continue Watching, Up Next and Continue Reading rows"
      }
    ]
  },
  {
    "version": "1.58.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.58.0",
    "summary": "A spookier Halloween effect with lightning and hand drawn creatures",
    "highlights": [
      {
        "title": "Feature",
        "description": "A spookier Halloween effect with lightning and hand drawn creatures"
      }
    ]
  },
  {
    "version": "1.57.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.57.0",
    "summary": "Monitor currently watched and continuing airing shows, remove movie notification mute toggle",
    "highlights": [
      {
        "title": "Feature",
        "description": "Monitor currently watched and continuing airing shows, remove movie notification mute toggle"
      }
    ]
  },
  {
    "version": "1.56.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.56.1",
    "summary": "Resolve syntax error in sleep option event listener",
    "highlights": [
      {
        "title": "Player",
        "description": "Resolve syntax error in sleep option event listener"
      }
    ]
  },
  {
    "version": "1.56.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.56.0",
    "summary": "Profile monthly analytics, spring pop-outs, next episode pre-buffering, and media sources caching",
    "highlights": [
      {
        "title": "Feature",
        "description": "Profile monthly analytics, spring pop-outs, next episode pre-buffering, and media sources caching"
      }
    ]
  },
  {
    "version": "1.55.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.55.0",
    "summary": "Add looking for devices loading state and empty state to cast popover",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add looking for devices loading state and empty state to cast popover"
      },
      {
        "title": "Feature",
        "description": "Add media tech badges, hero play/watchlist buttons, http2 scaling, sleep fadeout, and card image error fallbacks"
      },
      {
        "title": "Player",
        "description": "Customizable Up Next timer, dynamic credits gating, and post-play end-screen modal"
      },
      {
        "title": "Bug Fix",
        "description": "Hide sleep timer from settings on web/desktop where pill button is present"
      },
      {
        "title": "Cast",
        "description": "Clarify browser cast button and ignore user dismissal in error toast"
      }
    ]
  },
  {
    "version": "1.54.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.54.2",
    "summary": "Resolve cast button double toggle preventing popover from opening",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Resolve cast button double toggle preventing popover from opening"
      }
    ]
  },
  {
    "version": "1.54.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.54.1",
    "summary": "Keep skeleton beneath loaded rows, remove duplicate cast, declutter mobile player and media actions",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Keep skeleton beneath loaded rows, remove duplicate cast, declutter mobile player and media actions"
      }
    ]
  },
  {
    "version": "1.54.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.54.0",
    "summary": "In-library source search, skeleton loading, and formatted share text",
    "highlights": [
      {
        "title": "Feature",
        "description": "In-library source search, skeleton loading, and formatted share text"
      }
    ]
  },
  {
    "version": "1.53.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.53.0",
    "summary": "Add cast button and smart tv streaming support in player",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add cast button and smart tv streaming support in player"
      }
    ]
  },
  {
    "version": "1.52.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.52.1",
    "summary": "Center the loading spinner on a title page",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Center the loading spinner on a title page"
      }
    ]
  },
  {
    "version": "1.52.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.52.0",
    "summary": "Share button that copies a link to a title",
    "highlights": [
      {
        "title": "Feature",
        "description": "Share button that copies a link to a title"
      },
      {
        "title": "Feature",
        "description": "Share links from cards, manga series and manga chapters too"
      }
    ]
  },
  {
    "version": "1.51.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.51.0",
    "summary": "Picture in picture when leaving the tab, with a setting, and recover a frozen picture",
    "highlights": [
      {
        "title": "Feature",
        "description": "Picture in picture when leaving the tab, with a setting, and recover a frozen picture"
      }
    ]
  },
  {
    "version": "1.50.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.50.0",
    "summary": "Pinch to zoom in books and PDFs on touch screens",
    "highlights": [
      {
        "title": "Feature",
        "description": "Pinch to zoom in books and PDFs on touch screens"
      }
    ]
  },
  {
    "version": "1.49.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.49.1",
    "summary": "Support workflow_dispatch in publish workflow",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Support workflow_dispatch in publish workflow"
      },
      {
        "title": "Maintenance",
        "description": "Pass repo flag to gh commands in publish workflow"
      }
    ]
  },
  {
    "version": "1.49.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.49.0",
    "summary": "Video player media session and speed stepping, synchronous detail preview, listen drawer filter, and reader shortcuts",
    "highlights": [
      {
        "title": "Feature",
        "description": "Video player media session and speed stepping, synchronous detail preview, listen drawer filter, and reader shortcuts"
      },
      {
        "title": "Feature",
        "description": "Persistent subtitle offset, instant search, reader auto-immersive scroll, and audiobook shortcut cheat sheet"
      },
      {
        "title": "Feature",
        "description": "In-app trailer modal, episode quick-play, reader jump-to-page, paused frame stepping, and stream picker arrow navigation"
      }
    ]
  },
  {
    "version": "1.48.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.48.0",
    "summary": "Chapter drawer filter, active season auto-selection, mini-player scrubbing, and player shortcuts",
    "highlights": [
      {
        "title": "Feature",
        "description": "Chapter drawer filter, active season auto-selection, mini-player scrubbing, and player shortcuts"
      }
    ]
  },
  {
    "version": "1.47.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.47.0",
    "summary": "Player subtitle sync, double-tap seek, dialogue boost, instant detail preview, search filters, and chapter drawer",
    "highlights": [
      {
        "title": "Feature",
        "description": "Player subtitle sync, double-tap seek, dialogue boost, instant detail preview, search filters, and chapter drawer"
      },
      {
        "title": "Ci",
        "description": "Use GITHUB_TOKEN for release workflow"
      }
    ]
  },
  {
    "version": "1.46.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.46.0",
    "summary": "Search audiobooks by title, series, and author",
    "highlights": [
      {
        "title": "Audiobook",
        "description": "Search audiobooks by title, series, and author"
      }
    ]
  },
  {
    "version": "1.45.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.45.0",
    "summary": "Deduplicate chapters and pages in reading statistics and shelf counts",
    "highlights": [
      {
        "title": "Manga",
        "description": "Deduplicate chapters and pages in reading statistics and shelf counts"
      }
    ]
  },
  {
    "version": "1.44.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.44.1",
    "summary": "Group chapter search with sort controls on right side",
    "highlights": [
      {
        "title": "Manga",
        "description": "Group chapter search with sort controls on right side"
      },
      {
        "title": "Bug Fix",
        "description": "Preserve personal home rows across reader sessions and deduplicate search history"
      }
    ]
  },
  {
    "version": "1.44.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.44.0",
    "summary": "Persistent audiobook mini-player, downloads storage gauge, chapter jump, author bibliography, recent searches, and audiobook controls",
    "highlights": [
      {
        "title": "Feature",
        "description": "Persistent audiobook mini-player, downloads storage gauge, chapter jump, author bibliography, recent searches, and audiobook controls"
      }
    ]
  },
  {
    "version": "1.43.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.43.0",
    "summary": "Global offline auto-delete settings and collapsible manga series actions",
    "highlights": [
      {
        "title": "Feature",
        "description": "Global offline auto-delete settings and collapsible manga series actions"
      }
    ]
  },
  {
    "version": "1.42.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.42.0",
    "summary": "Per-manga scanlator filter like Mihon's",
    "highlights": [
      {
        "title": "Feature",
        "description": "Per-manga scanlator filter like Mihon's"
      },
      {
        "title": "Feature",
        "description": "Next and previous chapter in the manga reader"
      },
      {
        "title": "Feature",
        "description": "Mihon's chapter filters, sort and display for each series"
      },
      {
        "title": "Feature",
        "description": "Reader options like Mihon's for manga pages"
      },
      {
        "title": "Feature",
        "description": "Updates feed and automatic library refresh for manga"
      },
      {
        "title": "Feature",
        "description": "AniList tracking for manga series"
      },
      {
        "title": "Feature",
        "description": "Warn about duplicate series and switch a series to another source"
      },
      {
        "title": "Feature",
        "description": "New chapter notifications, library filters and display, download controls, more reader settings"
      },
      {
        "title": "Feature",
        "description": "Carry over download, filter, reader, and tracking controls across libraries"
      }
    ]
  },
  {
    "version": "1.41.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.41.2",
    "summary": "Line up the Library heading with the other shelf headings",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Line up the Library heading with the other shelf headings"
      }
    ]
  },
  {
    "version": "1.41.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.41.1",
    "summary": "Stop reading a growing stream's length as the episode's length",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Stop reading a growing stream's length as the episode's length"
      }
    ]
  },
  {
    "version": "1.41.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.41.0",
    "summary": "Smaller video downloads with Low, High and Higher and a time-left estimate",
    "highlights": [
      {
        "title": "Feature",
        "description": "Smaller video downloads with Low, High and Higher and a time-left estimate"
      },
      {
        "title": "Feature",
        "description": "Limit server conversions to two and use HEVC in the Mac app"
      },
      {
        "title": "Feature",
        "description": "Ask the player's engine what it can direct play"
      }
    ]
  },
  {
    "version": "1.40.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.40.2",
    "summary": "Clear the loading logo on a timer too, not only on media events",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Clear the loading logo on a timer too, not only on media events"
      },
      {
        "title": "Bug Fix",
        "description": "Also clear the loading logo when the video is drawing frames"
      }
    ]
  },
  {
    "version": "1.40.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.40.1",
    "summary": "Load every module under the plugin version so updates aren't stale",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Load every module under the plugin version so updates aren't stale"
      }
    ]
  },
  {
    "version": "1.40.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.40.0",
    "summary": "Show seek bar previews for titles without trickplay",
    "highlights": [
      {
        "title": "Feature",
        "description": "Show seek bar previews for titles without trickplay"
      },
      {
        "title": "Feature",
        "description": "Show macOS app updates in Settings About"
      },
      {
        "title": "Bug Fix",
        "description": "Remove the loading logo once playback is actually running"
      },
      {
        "title": "Bug Fix",
        "description": "Mark manga and books read, and make Remove from library stick"
      }
    ]
  },
  {
    "version": "1.39.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.39.0",
    "summary": "Read manga from Discover instead of requesting it",
    "highlights": [
      {
        "title": "Feature",
        "description": "Read manga from Discover instead of requesting it"
      },
      {
        "title": "Feature",
        "description": "Open the show, manga series or item from a Feed entry"
      },
      {
        "title": "Feature",
        "description": "Show reading books and manga, and listening, in Now Playing"
      },
      {
        "title": "Feature",
        "description": "Track time spent in the reader"
      },
      {
        "title": "Feature",
        "description": "Link titles in profile activity and show reading time"
      },
      {
        "title": "Feature",
        "description": "Split manga reading time from books on profiles"
      },
      {
        "title": "Bug Fix",
        "description": "Keep profile activity times aligned on the right"
      }
    ]
  },
  {
    "version": "1.38.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.38.0",
    "summary": "Import a series from another installed source when Mihon's source fails",
    "highlights": [
      {
        "title": "Feature",
        "description": "Import a series from another installed source when Mihon's source fails"
      },
      {
        "title": "Feature",
        "description": "Make the Manga shelf each reader's own library"
      },
      {
        "title": "Feature",
        "description": "Reading mode and crop borders in the manga reader's bottom bar"
      },
      {
        "title": "Bug Fix",
        "description": "Save a Mihon import's reading progress once per series instead of once per chapter"
      },
      {
        "title": "Bug Fix",
        "description": "Return the import result and source state together when queueing fails"
      },
      {
        "title": "Performance",
        "description": "Load streamed manga per series for each reader's own library"
      }
    ]
  },
  {
    "version": "1.37.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.37.0",
    "summary": "Full screen reading on phones, with toolbars hidden",
    "highlights": [
      {
        "title": "Feature",
        "description": "Full screen reading on phones, with toolbars hidden"
      },
      {
        "title": "Feature",
        "description": "Mihon-style comic reader with reading modes, zoom, crop borders and sliding menus"
      },
      {
        "title": "Feature",
        "description": "Map Mihon's paged vertical and long strip modes per series"
      },
      {
        "title": "Bug Fix",
        "description": "Show streamed manga when Suwayomi won't answer the full library query"
      },
      {
        "title": "Bug Fix",
        "description": "Skip a source that keeps timing out during a Mihon import"
      }
    ]
  },
  {
    "version": "1.36.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.36.0",
    "summary": "Add shelf categories, series settings and chapter bookmarks",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add shelf categories, series settings and chapter bookmarks"
      },
      {
        "title": "Feature",
        "description": "Import Mihon categories, history, bookmarks and series settings"
      },
      {
        "title": "Feature",
        "description": "Add categories to the Manga, Books and Audiobooks shelves"
      },
      {
        "title": "Feature",
        "description": "Add series notes, reading mode, chapter filters and bookmarks"
      },
      {
        "title": "Feature",
        "description": "Remove a whole series or show from downloads"
      },
      {
        "title": "Feature",
        "description": "Stream manga from Suwayomi's sources instead of downloading every chapter"
      },
      {
        "title": "Feature",
        "description": "Show streamed manga on the shelf and series page, with save to server"
      },
      {
        "title": "Feature",
        "description": "Read streamed chapters page by page"
      },
      {
        "title": "Feature",
        "description": "Download streamed chapters to the device"
      },
      {
        "title": "Bug Fix",
        "description": "Rename a shadowed variable in the Mihon backup reader"
      },
      {
        "title": "Docs",
        "description": "Describe streaming in the manga request and import screens"
      }
    ]
  },
  {
    "version": "1.35.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.35.1",
    "summary": "Treat Mihon backup series as in the library unless marked otherwise",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Treat Mihon backup series as in the library unless marked otherwise"
      }
    ]
  },
  {
    "version": "1.35.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.35.0",
    "summary": "Move Downloads to the sidebar's bottom section, above Group Watch",
    "highlights": [
      {
        "title": "Feature",
        "description": "Move Downloads to the sidebar's bottom section, above Group Watch"
      }
    ]
  },
  {
    "version": "1.34.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.34.0",
    "summary": "Download episodes and seasons from a show's episode list, and fold Download into More",
    "highlights": [
      {
        "title": "Feature",
        "description": "Download episodes and seasons from a show's episode list, and fold Download into More"
      },
      {
        "title": "Performance",
        "description": "Repackage compatible 1080p videos for download instead of re-encoding them"
      },
      {
        "title": "Performance",
        "description": "Download original video files in parallel parts when the server allows it"
      }
    ]
  },
  {
    "version": "1.33.5",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.33.5",
    "summary": "Show live download progress, and keep cached scripts from standing in for newer ones",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Show live download progress, and keep cached scripts from standing in for newer ones"
      }
    ]
  },
  {
    "version": "1.33.4",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.33.4",
    "summary": "Let video downloads get a conversion from Jellyfin, and stop waiting on a stalled one",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Let video downloads get a conversion from Jellyfin, and stop waiting on a stalled one"
      }
    ]
  },
  {
    "version": "1.33.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.33.3",
    "summary": "Download videos through playback negotiation, in the user's audio language, with retries",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Download videos through playback negotiation, in the user's audio language, with retries"
      }
    ]
  },
  {
    "version": "1.33.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.33.2",
    "summary": "Say why the reader couldn't open a book",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Say why the reader couldn't open a book"
      },
      {
        "title": "Bug Fix",
        "description": "Show the download menu, and download whole seasons from series pages"
      }
    ]
  },
  {
    "version": "1.33.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.33.1",
    "summary": "Open downloaded manga and books offline",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Open downloaded manga and books offline"
      }
    ]
  },
  {
    "version": "1.33.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.33.0",
    "summary": "Download books, manga, audiobooks and videos for offline use",
    "highlights": [
      {
        "title": "Feature",
        "description": "Download books, manga, audiobooks and videos for offline use"
      }
    ]
  },
  {
    "version": "1.32.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.32.0",
    "summary": "Give Settings a Reading section with translation and dictionary defaults",
    "highlights": [
      {
        "title": "Feature",
        "description": "Give Settings a Reading section with translation and dictionary defaults"
      }
    ]
  },
  {
    "version": "1.31.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.31.0",
    "summary": "Let readers remove their own Feed and profile entries, and admins anyone's",
    "highlights": [
      {
        "title": "Feature",
        "description": "Let readers remove their own Feed and profile entries, and admins anyone's"
      },
      {
        "title": "Feature",
        "description": "Show manga series' real covers and name the series in reading activity"
      }
    ]
  },
  {
    "version": "1.30.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.30.0",
    "summary": "Import a reader's Mihon library and reading progress through Suwayomi",
    "highlights": [
      {
        "title": "Feature",
        "description": "Import a reader's Mihon library and reading progress through Suwayomi"
      },
      {
        "title": "Feature",
        "description": "Group manga chapters into series with a chapter list, and name untagged audiobooks by folder"
      }
    ]
  },
  {
    "version": "1.29.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.29.0",
    "summary": "Add a setting to include NSFW-flagged Suwayomi sources in manga searches",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add a setting to include NSFW-flagged Suwayomi sources in manga searches"
      },
      {
        "title": "Bug Fix",
        "description": "Find Chaptarr books to request in either format, and point manga requests at Suwayomi when it isn't set up"
      },
      {
        "title": "Bug Fix",
        "description": "Tell apart a Suwayomi with no sources from one whose sources were all skipped"
      }
    ]
  },
  {
    "version": "1.28.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.28.1",
    "summary": "Explain empty Suwayomi manga searches and pick up newly installed sources",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Explain empty Suwayomi manga searches and pick up newly installed sources"
      },
      {
        "title": "Bug Fix",
        "description": "Send the format's quality profile when a book request adds a new author to Chaptarr"
      }
    ]
  },
  {
    "version": "1.28.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.28.0",
    "summary": "Add Suwayomi as a manga, manhwa and manhua request backend",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add Suwayomi as a manga, manhwa and manhua request backend"
      },
      {
        "title": "Feature",
        "description": "Request manga, manhwa and manhua chapters through Suwayomi from the Manga shelf and Discover"
      },
      {
        "title": "Bug Fix",
        "description": "Load Manga Discover covers through the server so blocked AniList images still show"
      }
    ]
  },
  {
    "version": "1.27.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.27.0",
    "summary": "Open CBR and CB7 comics in the reader",
    "highlights": [
      {
        "title": "Feature",
        "description": "Open CBR and CB7 comics in the reader"
      },
      {
        "title": "Feature",
        "description": "Give Manga a full shelf with requests and manga/manhwa/manhua Discover"
      }
    ]
  },
  {
    "version": "1.26.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.26.0",
    "summary": "Add a Manga shelf and a comic reader, and divide reading from video in the nav",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add a Manga shelf and a comic reader, and divide reading from video in the nav"
      },
      {
        "title": "Feature",
        "description": "Post reading and listening to the Feed and add reading achievements"
      },
      {
        "title": "Bug Fix",
        "description": "Only count monitored or downloaded books as already in Chaptarr"
      },
      {
        "title": "Bug Fix",
        "description": "Space Discover's rows like Home's and label trending by its source"
      },
      {
        "title": "Bug Fix",
        "description": "Keep Home's personal rows when watch state changes mid-load"
      }
    ]
  },
  {
    "version": "1.25.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.25.0",
    "summary": "Add a Discover screen for browsing books and audiobooks to request",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add a Discover screen for browsing books and audiobooks to request"
      },
      {
        "title": "Bug Fix",
        "description": "Show Continue Watching, Reading and Up Next as soon as they load"
      },
      {
        "title": "Bug Fix",
        "description": "Rename discovery request fallback local clashing with the request title"
      }
    ]
  },
  {
    "version": "1.24.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.24.0",
    "summary": "Show pages left on books in progress",
    "highlights": [
      {
        "title": "Feature",
        "description": "Show pages left on books in progress"
      },
      {
        "title": "Bug Fix",
        "description": "Show a book's real author instead of Chaptarr's lowercase sort key"
      }
    ]
  },
  {
    "version": "1.23.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.23.0",
    "summary": "Give books and audiobooks their own shelves with author and series rows",
    "highlights": [
      {
        "title": "Feature",
        "description": "Give books and audiobooks their own shelves with author and series rows"
      },
      {
        "title": "Feature",
        "description": "Upgrade the book reader with layouts, search and a PDF text layer"
      },
      {
        "title": "Feature",
        "description": "Add highlight, vocabulary, translation and dictionary endpoints for the reader"
      },
      {
        "title": "Feature",
        "description": "Highlight, annotate, look up and translate text in the reader"
      },
      {
        "title": "Feature",
        "description": "Add a vocabulary screen with flashcard review and Anki export"
      },
      {
        "title": "Bug Fix",
        "description": "Rename book search scope parameter clashing with a loop local"
      }
    ]
  },
  {
    "version": "1.22.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.22.0",
    "summary": "Fill in book covers and metadata from Chaptarr",
    "highlights": [
      {
        "title": "Feature",
        "description": "Fill in book covers and metadata from Chaptarr"
      }
    ]
  },
  {
    "version": "1.21.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.21.1",
    "summary": "Show real covers for book search results and book detail pages",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Show real covers for book search results and book detail pages"
      }
    ]
  },
  {
    "version": "1.21.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.21.0",
    "summary": "Request books straight from Chaptarr instead of Shelfarr",
    "highlights": [
      {
        "title": "Feature",
        "description": "Request books straight from Chaptarr instead of Shelfarr"
      }
    ]
  },
  {
    "version": "1.20.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.20.0",
    "summary": "Proxy book search/requests through Shelfarr, backend only",
    "highlights": [
      {
        "title": "Feature",
        "description": "Proxy book search/requests through Shelfarr, backend only"
      },
      {
        "title": "Feature",
        "description": "Show a native Jellyfin Books library as real book shelves"
      },
      {
        "title": "Feature",
        "description": "Track book reading progress and add Continue Reading/Listening rows"
      },
      {
        "title": "Feature",
        "description": "Add a native EPUB/PDF reader for Jellyfin Book items"
      },
      {
        "title": "Feature",
        "description": "Add a native audiobook player for Jellyfin AudioBook items"
      },
      {
        "title": "Feature",
        "description": "Request books from Shelfarr right on the Books shelf"
      },
      {
        "title": "Refactor",
        "description": "Remove the Audiobookshelf integration now that books are native"
      }
    ]
  },
  {
    "version": "1.19.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.19.0",
    "summary": "Re-embed Audiobookshelf in an iframe now that its CSP is fixed",
    "highlights": [
      {
        "title": "Feature",
        "description": "Re-embed Audiobookshelf in an iframe now that its CSP is fixed"
      },
      {
        "title": "Revert",
        "description": "Open Audiobookshelf in a new tab, not an iframe"
      }
    ]
  },
  {
    "version": "1.18.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.18.0",
    "summary": "Add a config-driven Books sidebar entry linking to Audiobookshelf",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add a config-driven Books sidebar entry linking to Audiobookshelf"
      },
      {
        "title": "Feature",
        "description": "Embed Audiobookshelf in an iframe instead of a new tab"
      },
      {
        "title": "Bug Fix",
        "description": "Wait for the stopped-playback report before Home re-fetches Up Next/Continue Watching"
      }
    ]
  },
  {
    "version": "1.17.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.17.0",
    "summary": "Add a Dismiss button to the Skip Intro/Credits card",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add a Dismiss button to the Skip Intro/Credits card"
      },
      {
        "title": "Performance",
        "description": "Allow codec-compatible MKV sources to genuinely Direct Play"
      }
    ]
  },
  {
    "version": "1.16.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.16.0",
    "summary": "Turn Skip Intro/Credits into a card matching Up Next's style",
    "highlights": [
      {
        "title": "Feature",
        "description": "Turn Skip Intro/Credits into a card matching Up Next's style"
      }
    ]
  },
  {
    "version": "1.15.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.15.0",
    "summary": "Change profile picture directly from your own Profile page",
    "highlights": [
      {
        "title": "Feature",
        "description": "Change profile picture directly from your own Profile page"
      },
      {
        "title": "Bug Fix",
        "description": "Carry the current audio language forward on Up Next auto-advance"
      },
      {
        "title": "Bug Fix",
        "description": "Stop the player's loading logo getting stuck on a real playback failure"
      },
      {
        "title": "Bug Fix",
        "description": "Merge Skip Intro/Credits per category instead of per tier"
      },
      {
        "title": "Performance",
        "description": "Skip the guaranteed-403 SkipMe.db tier by default and cache community-skip misses"
      }
    ]
  },
  {
    "version": "1.14.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.14.1",
    "summary": "SkipMe.db rejecting every request for a missing User-Agent",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "SkipMe.db rejecting every request for a missing User-Agent"
      },
      {
        "title": "Bug Fix",
        "description": "Make every Skip Intro/Credits community tier's outcome visible in logs"
      }
    ]
  },
  {
    "version": "1.14.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.14.0",
    "summary": "Add SkipMe.db and IntroDB as two more Skip Intro/Credits community sources",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add SkipMe.db and IntroDB as two more Skip Intro/Credits community sources"
      },
      {
        "title": "Docs",
        "description": "Correct a wrong claim about SkipDB's real data dump size"
      }
    ]
  },
  {
    "version": "1.13.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.13.1",
    "summary": "Stop caching the Skip Intro/Credits admin menu toggle forever",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Stop caching the Skip Intro/Credits admin menu toggle forever"
      }
    ]
  },
  {
    "version": "1.13.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.13.0",
    "summary": "Stop expensive Skip Intro/Credits analysis on playback, add admin-triggered scan",
    "highlights": [
      {
        "title": "Feature",
        "description": "Stop expensive Skip Intro/Credits analysis on playback, add admin-triggered scan"
      },
      {
        "title": "Feature",
        "description": "Add a server side toggle for the Skip Intro/Credits admin menu"
      },
      {
        "title": "Feature",
        "description": "Split the Skip Intro/Credits scan into Quick and Deep, add Episode/Season scope"
      }
    ]
  },
  {
    "version": "1.12.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.12.0",
    "summary": "Add TheIntroDB as the primary Skip Intro/Credits source",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add TheIntroDB as the primary Skip Intro/Credits source"
      }
    ]
  },
  {
    "version": "1.11.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.11.0",
    "summary": "Add NuvioTV-style community Skip Intro/Credits as the primary tier",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add NuvioTV-style community Skip Intro/Credits as the primary tier"
      },
      {
        "title": "Bug Fix",
        "description": "Analyze forward-looking batches inside a real request, not a background sweep"
      }
    ]
  },
  {
    "version": "1.10.4",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.10.4",
    "summary": "Give Gelato a synthetic HttpContext during background analysis",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Give Gelato a synthetic HttpContext during background analysis"
      }
    ]
  },
  {
    "version": "1.10.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.10.3",
    "summary": "Log server-side analysis at Information, force manual re-attempts",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Log server-side analysis at Information, force manual re-attempts"
      }
    ]
  },
  {
    "version": "1.10.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.10.2",
    "summary": "Log why the chapter fallback finds nothing, visibly",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Log why the chapter fallback finds nothing, visibly"
      }
    ]
  },
  {
    "version": "1.10.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.10.1",
    "summary": "Use console.warn for the native Media Segments diagnostic",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Use console.warn for the native Media Segments diagnostic"
      }
    ]
  },
  {
    "version": "1.10.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.10.0",
    "summary": "Sweep the whole library for intro/credits, auto-trigger on import",
    "highlights": [
      {
        "title": "Feature",
        "description": "Sweep the whole library for intro/credits, auto-trigger on import"
      },
      {
        "title": "Bug Fix",
        "description": "Harden and log the native Media Segments read"
      }
    ]
  },
  {
    "version": "1.9.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.9.0",
    "summary": "Build our own cross-episode intro/credits analyzer",
    "highlights": [
      {
        "title": "Feature",
        "description": "Build our own cross-episode intro/credits analyzer"
      },
      {
        "title": "Bug Fix",
        "description": "Fall back to embedded chapter names for Skip Intro/Credits"
      },
      {
        "title": "Bug Fix",
        "description": "Stop naming Jellyfin's own User type directly"
      }
    ]
  },
  {
    "version": "1.8.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.8.0",
    "summary": "Show the TMDB rating badge on poster cards",
    "highlights": [
      {
        "title": "Feature",
        "description": "Show the TMDB rating badge on poster cards"
      }
    ]
  },
  {
    "version": "1.7.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.7.1",
    "summary": "Make Up Next timing configurable and lower its default trigger",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Make Up Next timing configurable and lower its default trigger"
      }
    ]
  },
  {
    "version": "1.7.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.7.0",
    "summary": "Add a volume control to the player",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add a volume control to the player"
      },
      {
        "title": "Bug Fix",
        "description": "Re-check scroll arrows on resize, not just once at mount"
      }
    ]
  },
  {
    "version": "1.6.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.6.0",
    "summary": "Add scroll arrows to the Studio Hubs row",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add scroll arrows to the Studio Hubs row"
      }
    ]
  },
  {
    "version": "1.5.4",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.5.4",
    "summary": "Check activeElement too for list-membership-menu outside clicks",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Check activeElement too for list-membership-menu outside clicks"
      }
    ]
  },
  {
    "version": "1.5.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.5.3",
    "summary": "Stop Watchlist/Grouplist checks from collapsing Detail's actions row",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Stop Watchlist/Grouplist checks from collapsing Detail's actions row"
      }
    ]
  },
  {
    "version": "1.5.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.5.2",
    "summary": "Stop rebuilding catalog/genre rows on every playback session end",
    "highlights": [
      {
        "title": "Performance",
        "description": "Stop rebuilding catalog/genre rows on every playback session end"
      }
    ]
  },
  {
    "version": "1.5.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.5.1",
    "summary": "Stop forcing blur before opening the profile switcher",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Stop forcing blur before opening the profile switcher"
      }
    ]
  },
  {
    "version": "1.5.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.5.0",
    "summary": "Auto-select a saved subtitle language preference on playback start",
    "highlights": [
      {
        "title": "Feature",
        "description": "Auto-select a saved subtitle language preference on playback start"
      },
      {
        "title": "Feature",
        "description": "Detect MULTi/Dual Audio releases with no other language signal"
      },
      {
        "title": "Bug Fix",
        "description": "Show the language filter row even with a single language"
      }
    ]
  },
  {
    "version": "1.4.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.4.2",
    "summary": "Give Season its own episode-resolving Play, not a raw stream picker",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Give Season its own episode-resolving Play, not a raw stream picker"
      }
    ]
  },
  {
    "version": "1.4.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.4.1",
    "summary": "Replace SortBy=Random with CommunityRating + client shuffle",
    "highlights": [
      {
        "title": "Performance",
        "description": "Replace SortBy=Random with CommunityRating + client shuffle"
      }
    ]
  },
  {
    "version": "1.4.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.4.0",
    "summary": "Add Mark season as unwatched to the episode options menu",
    "highlights": [
      {
        "title": "Feature",
        "description": "Add Mark season as unwatched to the episode options menu"
      }
    ]
  },
  {
    "version": "1.3.6",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.3.6",
    "summary": "Shorten the prebuffer wait for a confirmed-cached source",
    "highlights": [
      {
        "title": "Performance",
        "description": "Shorten the prebuffer wait for a confirmed-cached source"
      }
    ]
  },
  {
    "version": "1.3.5",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.3.5",
    "summary": "Keep player episode thumbnails at their real 16:9 height",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Keep player episode thumbnails at their real 16:9 height"
      }
    ]
  },
  {
    "version": "1.3.4",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.3.4",
    "summary": "Use ApiKey instead of api_key for URLs a browser element builds directly",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Use ApiKey instead of api_key for URLs a browser element builds directly"
      }
    ]
  },
  {
    "version": "1.3.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.3.3",
    "summary": "Log the real MediaError on a failed video playback attempt",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Log the real MediaError on a failed video playback attempt"
      },
      {
        "title": "Performance",
        "description": "Prefetch Series cards too, not just Movie/Episode"
      },
      {
        "title": "Performance",
        "description": "Debounce Gelato prefetch instead of firing on every focus"
      },
      {
        "title": "Performance",
        "description": "Prefetch next episode's streams as soon as it's known"
      }
    ]
  },
  {
    "version": "1.3.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.3.2",
    "summary": "Prefetch Gelato streams on card hover/focus",
    "highlights": [
      {
        "title": "Performance",
        "description": "Prefetch Gelato streams on card hover/focus"
      },
      {
        "title": "Performance",
        "description": "Split search into independent Movies/Series requests"
      },
      {
        "title": "Other",
        "description": "Gelato prefetch wiring and split search"
      }
    ]
  },
  {
    "version": "1.3.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.3.1",
    "summary": "Don't merge episodes across a season boundary into one binge group",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Don't merge episodes across a season boundary into one binge group"
      }
    ]
  },
  {
    "version": "1.3.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.3.0",
    "summary": "Let an admin delete a feed entry, relock a badge, and reset a user's progress",
    "highlights": [
      {
        "title": "Feature",
        "description": "Let an admin delete a feed entry, relock a badge, and reset a user's progress"
      },
      {
        "title": "Bug Fix",
        "description": "Don't credit a real watch from 'ended' before playback ever started"
      }
    ]
  },
  {
    "version": "1.2.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.2.1",
    "summary": "Retry a failed subtitle load instead of giving up after one attempt",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Retry a failed subtitle load instead of giving up after one attempt"
      }
    ]
  },
  {
    "version": "1.2.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.2.0",
    "summary": "Split search results into Movies and Series sections",
    "highlights": [
      {
        "title": "Feature",
        "description": "Split search results into Movies and Series sections"
      },
      {
        "title": "Bug Fix",
        "description": "Let the language filter treat original-audio-only as its own choice"
      }
    ]
  },
  {
    "version": "1.1.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.1.0",
    "summary": "Tag original-audio-only sources, add a language filter to Change Stream",
    "highlights": [
      {
        "title": "Feature",
        "description": "Tag original-audio-only sources, add a language filter to Change Stream"
      }
    ]
  },
  {
    "version": "1.0.5",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.0.5",
    "summary": "Pin subtitle cues to a fixed real percentage, not auto line stacking",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Pin subtitle cues to a fixed real percentage, not auto line stacking"
      },
      {
        "title": "Docs",
        "description": "Add a README"
      }
    ]
  },
  {
    "version": "1.0.4",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.0.4",
    "summary": "Stop the final playback-stopped report from undoing a real watch",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Stop the final playback-stopped report from undoing a real watch"
      }
    ]
  },
  {
    "version": "1.0.3",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.0.3",
    "summary": "Credit a real watch as soon as Up Next appears, not only on ended",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Credit a real watch as soon as Up Next appears, not only on ended"
      },
      {
        "title": "Bug Fix",
        "description": "Use the real observed duration for Continue Watching too, not just achievements"
      },
      {
        "title": "Bug Fix",
        "description": "Mark a real watch played in native Jellyfin too, not just this plugin's own state"
      }
    ]
  },
  {
    "version": "1.0.2",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.0.2",
    "summary": "Stop git-cliff from splitting commit bodies into duplicate changelog entries",
    "highlights": [
      {
        "title": "Release",
        "description": "Stop git-cliff from splitting commit bodies into duplicate changelog entries"
      },
      {
        "title": "Bug Fix",
        "description": "Credit a real watch on natural playback end, not just the 90% ratio"
      }
    ]
  },
  {
    "version": "1.0.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.0.1",
    "summary": "Credit achievements off the real stream duration, not metadata",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      },
      {
        "title": "Other",
        "description": "Credit achievements off the real stream duration, not metadata"
      }
    ]
  },
  {
    "version": "1.0.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 1.0.0",
    "summary": "Restarts Jellio's version counter past Jellio-Plugin's last release (0.89.5.0), fixing the version-comparison mismatch that kept the plugin catalog from offering updates.",
    "highlights": [
      {
        "title": "Release Notes",
        "description": "Restarts Jellio's version counter past Jellio-Plugin's last release (0.89.5.0), fixing the version-comparison mismatch that kept the plugin catalog from offering updates."
      }
    ]
  },
  {
    "version": "0.9.1",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.9.1",
    "summary": "Guard against a stale subtitle track load race",
    "highlights": [
      {
        "title": "Bug Fix",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      },
      {
        "title": "Other",
        "description": "Guard against a stale subtitle track load race"
      }
    ]
  },
  {
    "version": "0.9.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.9.0",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "0.8.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.8.0",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "0.7.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.7.0",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "0.6.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.6.0",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "0.5.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.5.0",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "0.4.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.4.0",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "0.3.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.3.0",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "0.2.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.2.0",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  },
  {
    "version": "0.1.0",
    "title": "What's New in Jellio",
    "subtitle": "Version 0.1.0",
    "summary": "Internal improvements and bug fixes.",
    "highlights": [
      {
        "title": "Maintenance",
        "description": "Internal improvements and bug fixes."
      }
    ]
  }
];

export const LATEST_CHANGELOG = CHANGELOG_RELEASES[0];
export const LATEST_BIG_CHANGELOG = CHANGELOG_RELEASES.find((r) => isBigRelease(r.version)) || LATEST_CHANGELOG;

export const MACOS_CHANGELOG_RELEASES = [
  {
    "version": "0.6.1",
    "title": "What's New in Jellio for macOS",
    "subtitle": "Version 0.6.1",
    "summary": "Jellio opens faster.",
    "highlights": [
      {
        "title": "Faster Start",
        "description": "The Jellio window now appears as soon as you open the app instead of waiting for your server, and the connection to your server is set up while the window opens."
      },
      {
        "title": "Lighter First Load",
        "description": "The Dock download count no longer checks your downloads while Jellio is still loading."
      }
    ]
  },
  {
    "version": "0.6.0",
    "title": "What's New in Jellio for macOS",
    "subtitle": "Version 0.6.0",
    "summary": "Native What's New window with complete version history and menu integration.",
    "highlights": [
      {
        "title": "Native Expandable Version History",
        "description": "Inspect the complete release history across all past versions in an interactive, cleanly collapsible modal."
      },
      {
        "title": "Menu Bar What's New Shortcut",
        "description": "Easily review the latest feature additions and changes anytime from the Jellio application menu and Help menu."
      },
      {
        "title": "Notification & State Cleanup",
        "description": "Stale update notifications and changelog dismiss flags are automatically cleared when major releases arrive."
      }
    ]
  },
  {
    "version": "0.5.0",
    "title": "What's New in Jellio for macOS",
    "subtitle": "Version 0.5.0",
    "summary": "Global media keys, display sleep prevention, and Apple Silicon hardware decoding.",
    "highlights": [
      {
        "title": "Global Media Keys",
        "description": "Control playback from anywhere using keyboard media keys (Play/Pause, Next Track, Previous Track)."
      },
      {
        "title": "Display Sleep Prevention",
        "description": "Prevents display sleep automatically while a video is playing, without keeping your Mac awake when idle."
      },
      {
        "title": "Hardware Video Acceleration",
        "description": "Enhanced Apple Silicon hardware decoding flags for zero-copy 4K and HEVC playback with minimal battery draw."
      }
    ]
  },
  {
    "version": "0.4.1",
    "title": "What's New in Jellio for macOS",
    "subtitle": "Version 0.4.1",
    "summary": "Direct network routing fix.",
    "highlights": [
      {
        "title": "Direct Network Routing",
        "description": "Streams and API calls connect directly to your server without proxying through the main Electron process."
      }
    ]
  },
  {
    "version": "0.4.0",
    "title": "What's New in Jellio for macOS",
    "subtitle": "Version 0.4.0",
    "summary": "Native dock menu, download badges, and quit protection.",
    "highlights": [
      {
        "title": "Native Dock Menu & Alerts",
        "description": "Quick navigation dock menu, running download badge counts, and graceful exit confirmations."
      },
      {
        "title": "Apple Silicon Zero-Copy Decoding",
        "description": "Optimized GPU rasterization and zero-copy video buffer transfers for M-series chips."
      }
    ]
  },
  {
    "version": "0.3.0",
    "title": "What's New in Jellio for macOS",
    "subtitle": "Version 0.3.0",
    "summary": "HEVC offline downloads support.",
    "highlights": [
      {
        "title": "HEVC Offline Downloads",
        "description": "Download movies and episodes in HEVC format when supported by the server, saving disk space and bandwidth."
      }
    ]
  },
  {
    "version": "0.2.0",
    "title": "What's New in Jellio for macOS",
    "subtitle": "Version 0.2.0",
    "summary": "In-app updater.",
    "highlights": [
      {
        "title": "In-App Automatic Updates",
        "description": "Seamless background update checks and one-click installation directly from Settings > About."
      }
    ]
  },
  {
    "version": "0.1.0",
    "title": "What's New in Jellio for macOS",
    "subtitle": "Version 0.1.0",
    "summary": "Initial macOS desktop release.",
    "highlights": [
      {
        "title": "Native macOS App",
        "description": "Runs Jellio in a dedicated native window with seamless server setup, offline support, and Dock download integration."
      }
    ]
  }
];

function storageKey() {
  const userId = getCurrentUserId() || 'global';
  return 'jellio_last_seen_changelog_' + userId;
}

export function shouldShowChangelogNotification() {
  // Notifications and toasts are only triggered by big releases (1.4X.0)
  if (!isBigRelease(LATEST_BIG_CHANGELOG.version)) {
    return false;
  }
  return !hasSeenLatestChangelog();
}

export function hasSeenLatestChangelog() {
  if (!isBigRelease(LATEST_BIG_CHANGELOG.version)) {
    return true;
  }
  try {
    const key = storageKey();
    const seen = localStorage.getItem(key);
    if (seen && seen !== LATEST_BIG_CHANGELOG.version) {
      // Clear older version from storage so the new big release is fresh
      localStorage.removeItem(key);
      return false;
    }
    return seen === LATEST_BIG_CHANGELOG.version;
  } catch (err) {
    return false;
  }
}

export function clearPreviousChangelogs() {
  try {
    localStorage.removeItem(storageKey());
  } catch (_) {}
}

export function markLatestChangelogSeen() {
  try {
    localStorage.setItem(storageKey(), LATEST_BIG_CHANGELOG.version);
  } catch (err) {
    console.warn('Jellio: could not save changelog state', err);
  }
}

export function getChangelogNotification() {
  const rel = LATEST_BIG_CHANGELOG;
  return {
    Id: 'changelog:' + rel.version,
    Name: rel.title,
    Kind: 'whatsnew',
    Detail: rel.subtitle + ': ' + rel.summary,
    Date: new Date().toISOString(),
    Read: false,
    Highlights: rel.highlights,
  };
}
