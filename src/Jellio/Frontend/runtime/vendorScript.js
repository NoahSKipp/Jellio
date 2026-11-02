import { jellioVersion } from './util.js';
const loaded = new Map();

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
