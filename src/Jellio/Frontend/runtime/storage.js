// localStorage with every access guarded: in private mode, with storage
// blocked or the quota full, reads come back as the fallback and writes
// report false instead of throwing.

function store() {
  return window.localStorage;
}

export function readString(key, fallback = null) {
  try {
    const value = store().getItem(key);
    return value === null || value === undefined ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

export function writeString(key, value) {
  try {
    store().setItem(key, value);
    return true;
  } catch (err) {
    return false;
  }
}

// Missing or unparseable JSON reads as the fallback.
export function readJson(key, fallback = null) {
  const raw = readString(key);
  if (raw === null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    store().setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

export function remove(key) {
  try {
    store().removeItem(key);
    return true;
  } catch (err) {
    return false;
  }
}

// False when storage cannot even be read (blocked site data), as opposed
// to a key that is simply missing.
export function storageReadable() {
  try {
    store().getItem('');
    return true;
  } catch (err) {
    return false;
  }
}
