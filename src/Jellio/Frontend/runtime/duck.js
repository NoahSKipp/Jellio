// True while a sent sound is playing and other media is turned down, so
// volume listeners don't save the lowered level as the reader's choice.
let ducking = 0;

export function isDucking() {
  return ducking > 0;
}

export function beginDuck() {
  ducking++;
}

export function endDuck() {
  ducking = Math.max(0, ducking - 1);
}
