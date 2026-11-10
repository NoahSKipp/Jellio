// What can be downloaded, without loading components/downloads.js.

export function downloadKindFor(item, bookKind) {
  if (item.Type === 'AudioBook') return 'audiobook';
  if (item.Type === 'Book') return bookKind === 'manga' || /\.(cbz|cbr|cb7|cbt)$/i.test(item.Path || '') ? 'manga' : 'book';
  if (item.Type === 'Movie' || item.Type === 'Episode' || item.Type === 'Video' || item.Type === 'MusicVideo') return 'video';
  return null;
}

export function canDownload(item) {
  return (
    'caches' in window &&
    'indexedDB' in window &&
    (!!downloadKindFor(item) || item.Type === 'Series' || item.Type === 'Season')
  );
}
