// Image widths to ask the server for: the displayed width times the pixel
// ratio, rounded up to a few shared sizes so cards reuse cached images.
const WIDTH_BUCKETS = [240, 320, 400, 480, 640];
const MAX_PIXEL_RATIO = 2;

export function bucketedImageWidth(cssWidth, pixelRatio) {
  const ratio = Math.min(MAX_PIXEL_RATIO, Math.max(1, Number(pixelRatio) || 1));
  const target = cssWidth * ratio;
  for (let i = 0; i < WIDTH_BUCKETS.length; i++) {
    if (WIDTH_BUCKETS[i] >= target) return WIDTH_BUCKETS[i];
  }
  return WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1];
}

function pixelRatio() {
  return typeof window !== 'undefined' ? window.devicePixelRatio : 1;
}

// Poster cards top out at 180px wide (css .jellio-card), a little more in
// library grids; landscape cards at 340px (.jellio-card-landscape).
export function posterImageWidth() {
  return bucketedImageWidth(180, pixelRatio());
}

export function landscapeImageWidth() {
  return bucketedImageWidth(340, pixelRatio());
}
