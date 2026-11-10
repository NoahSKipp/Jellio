// Collects what a screen sets up (timers, listeners, observers) so one
// dispose() undoes all of it, newest first. Anything registered after
// dispose() is undone straight away.
export function createScope() {
  const disposers = [];
  let disposed = false;

  function add(dispose) {
    if (disposed) run(dispose);
    else disposers.push(dispose);
  }

  function run(dispose) {
    try {
      dispose();
    } catch (err) {
      console.warn('Jellio: teardown step failed', err);
    }
  }

  return {
    interval(fn, ms) {
      const id = window.setInterval(fn, ms);
      add(function () {
        window.clearInterval(id);
      });
      return id;
    },
    timeout(fn, ms) {
      const id = window.setTimeout(fn, ms);
      add(function () {
        window.clearTimeout(id);
      });
      return id;
    },
    listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      add(function () {
        target.removeEventListener(type, handler, options);
      });
      return handler;
    },
    observe(observer) {
      add(function () {
        observer.disconnect();
      });
      return observer;
    },
    onDispose(fn) {
      add(fn);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      while (disposers.length) run(disposers.pop());
    },
    get disposed() {
      return disposed;
    },
  };
}
