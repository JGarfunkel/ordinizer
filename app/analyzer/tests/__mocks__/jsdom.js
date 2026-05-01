// Manual mock for jsdom to avoid ESM dependency chain issues in Jest (CJS mode)
class VirtualConsole {
  forwardTo() {}
  on() {}
}

class JSDOM {
  constructor(html) {
    this._html = html || '';
    this.window = {
      document: {
        title: '',
        querySelectorAll: () => ({ forEach: () => {} }),
        querySelector: () => null,
      },
    };
  }
  serialize() {
    return this._html;
  }
}

module.exports = { JSDOM, VirtualConsole };
