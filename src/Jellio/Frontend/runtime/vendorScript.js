// Loads one of the UMD bundles under Frontend/vendor (epub.js, JSZip,
// pdf.js) on demand, as a plain <script>: they publish browser globals
// (window.ePub, window.JSZip, window.pdfjsLib), not ES modules. Loaded
// once per page, and only when a reader actually opens a book, so none
// of this weight lands on anyone who never does.
const loaded = new Map();

function jellioVersion() {
  const script = document.querySelector('script[src*="/Jellio/frontend/app.js"]');
  if (!script) return '';
  try {
    return new URL(script.src, window.location.origin).searchParams.get('v') || '';
  } catch (err) {
    return '';
  }
}

export function vendorUrl(file) {
  const version = jellioVersion();
  return '/Jellio/frontend/vendor/' + file + (version ? '?v=' + version : '');
}

export function loadVendorScript(file) {
  if (loaded.has(file)) return loaded.get(file);
  const promise = new Promise(function (resolve, reject) {
    const script = document.createElement('script');
    script.src = vendorUrl(file);
    script.async = true;
    script.onload = function () {
      resolve();
    };
    script.onerror = function () {
      loaded.delete(file);
      script.remove();
      reject(new Error('Could not load ' + file));
    };
    document.head.appendChild(script);
  });
  loaded.set(file, promise);
  return promise;
}
