// Player keyboard shortcuts.
// Built by screens/player.js; live is its playerLive accessor object.

export function createPlayerKeydown(deps, live) {
  const {
    adjustVolume, closeSidePanels, episodesPanel, isTypingTarget, performSeek, playPauseButton, popovers,
    shortcutsModal, skipBackButton, skipForwardButton, sourcePanel, stepPlaybackSpeed, subtitleButton,
    toggleMute, updateSubtitleOffset, video,
  } = deps;

  function onPlayerKeydown(event) {
    if (live.screenTornDown || isTypingTarget(event.target)) return;
    if (live.endScreenModalInstance) {
      if (event.key === 'Escape') {
        event.preventDefault();
        live.endScreenModalInstance.cleanup();
        live.endScreenModalInstance = null;
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (live.endScreenModalInstance.primaryBtn) {
          live.endScreenModalInstance.primaryBtn.click();
        }
        return;
      }
      return;
    }
    if (event.altKey && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault();
      live.toggleCastMenu();
      return;
    }
    if (event.key === 'MediaPlayPause') {
      event.preventDefault();
      playPauseButton.click();
      return;
    }
    if (event.key === 'MediaTrackNext' || event.key === 'MediaNextTrack') {
      event.preventDefault();
      skipForwardButton.click();
      return;
    }
    if (event.key === 'MediaTrackPrevious' || event.key === 'MediaPreviousTrack') {
      event.preventDefault();
      skipBackButton.click();
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    switch (event.key) {
      case ' ':
      case 'Spacebar':
      case 'k':
      case 'K':
        event.preventDefault();
        playPauseButton.click();
        break;
      case 'ArrowLeft':
      case 'j':
      case 'J':
        event.preventDefault();
        skipBackButton.click();
        break;
      case 'ArrowRight':
      case 'l':
      case 'L':
        event.preventDefault();
        skipForwardButton.click();
        break;
      case 'ArrowUp':
        event.preventDefault();
        adjustVolume(0.1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        adjustVolume(-0.1);
        break;
      case 'f':
      case 'F':
        if (live.fullscreenButton) live.fullscreenButton.click();
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'c':
      case 'C':
        subtitleButton.click();
        break;
      case 'z':
      case 'Z':
        event.preventDefault();
        updateSubtitleOffset(-0.1);
        break;
      case 'x':
      case 'X':
        event.preventDefault();
        updateSubtitleOffset(0.1);
        break;
      case ',':
        if (video.paused) {
          event.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 0.04);
        }
        break;
      case '.':
        if (video.paused) {
          event.preventDefault();
          video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 0.04);
        }
        break;
      case '>':
        event.preventDefault();
        stepPlaybackSpeed(1);
        break;
      case '<':
        event.preventDefault();
        stepPlaybackSpeed(-1);
        break;
      case 's':
      case 'S':
        if (!live.skipOverlay.overlay.classList.contains('jellio-player-skip-hidden')) {
          performSeek(live.skipTargetSeconds);
        }
        break;
      case '?':
        event.preventDefault();
        live.toggleShortcutsModal();
        break;
      case 'Escape': {
        if (!shortcutsModal.classList.contains('jellio-player-shortcuts-modal-hidden')) {
          live.closeShortcutsModal();
          break;
        }
        const openPopover = popovers.find(function (entry) {
          return !entry.menu.classList.contains('jellio-player-popover-hidden');
        });
        if (openPopover) {
          openPopover.menu.classList.add('jellio-player-popover-hidden');
        } else if (!sourcePanel.classList.contains('jellio-player-sidepanel-hidden') || !episodesPanel.classList.contains('jellio-player-sidepanel-hidden')) {
          closeSidePanels();
        } else {
          live.closeChatPanel();
        }
        break;
      }
      default:
        break;
    }
  }
  return { onPlayerKeydown };
}
