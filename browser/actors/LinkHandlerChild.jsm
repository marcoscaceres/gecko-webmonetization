/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["LinkHandlerChild"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

ChromeUtils.defineModuleGetter(
  this,
  "FaviconLoader",
  "resource:///modules/FaviconLoader.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "MonetizationLoader",
  "resource:///modules/MonetizationLoader.jsm"
);

class LinkHandlerChild extends JSWindowActorChild {
  constructor() {
    super();

    this.seenTabIcon = false;
    this._iconLoader = null;
    this._monetizationLoader = null;
  }

  get monetizationLoader() {
    if (!this._monetizationLoader) {
      this._monetizationLoader = new MonetizationLoader(this);
    }
    return this._monetizationLoader;
  }

  get iconLoader() {
    if (!this._iconLoader) {
      this._iconLoader = new FaviconLoader(this);
    }
    return this._iconLoader;
  }

  addRootIcon() {
    if (
      !this.seenTabIcon &&
      Services.prefs.getBoolPref("browser.chrome.guess_favicon", true) &&
      Services.prefs.getBoolPref("browser.chrome.site_icons", true)
    ) {
      // Inject the default icon. Use documentURIObject so that we do the right
      // thing with about:-style error pages. See bug 453442
      let pageURI = this.document.documentURIObject;
      if (["http", "https"].includes(pageURI.scheme)) {
        this.seenTabIcon = true;
        this.iconLoader.addDefaultIcon(pageURI);
      }
    }
  }

  onHeadParsed(event) {
    if (event.target.ownerDocument != this.document) {
      return;
    }

    // Per spec icons are meant to be in the <head> tag so we should have seen
    // all the icons now so add the root icon if no other tab icons have been
    // seen.
    this.addRootIcon();

    // We're likely done with icon parsing so load the pending icons now.
    if (this._iconLoader) {
      this._iconLoader.onPageShow();
    }
    this._monetizationLoader?.onPageShow(this.document);
  }

  onPageShow(event) {
    if (event.target != this.document) {
      return;
    }

    this.addRootIcon();

    if (this._iconLoader) {
      this._iconLoader.onPageShow();
    }

    this._monetizationLoader?.onPageShow(this.document);
  }

  onPageHide(event) {
    if (event.target != this.document) {
      return;
    }

    if (this._iconLoader) {
      this._iconLoader.onPageHide();
    }
    this.seenTabIcon = false;

    this._monetizationLoader?.onPageHide(this.document);
  }

  onVisibilityChange(event) {
    if (
      event.target != this.document ||
      this.document.ownerGlobal != this.contentWindow
    ) {
      // Verify if these cases are even possible.
      return;
    }

    // TODO: there must be a better way t
    const url = this.document.location;
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return;
    }

    this.monetizationLoader.onVisbilityChange(this.document);
  }

  onLinkEvent(event) {
    let link = event.target;
    // Ignore sub-frames (bugs 305472, 479408).
    if (link.ownerGlobal != this.contentWindow) {
      return;
    }

    let rel = link.rel && link.rel.toLowerCase();
    // We also check .getAttribute, since an empty href attribute will give us
    // a link.href that is the same as the document.
    if (!rel || !link.href || !link.getAttribute("href")) {
      return;
    }

    // Note: following booleans only work for the current link, not for the
    // whole content
    let iconAdded = false;
    let searchAdded = false;
    let rels = {};
    for (let relString of rel.split(/\s+/)) {
      rels[relString] = true;
    }

    for (let relVal in rels) {
      let isRichIcon = false;

      switch (relVal) {
        case "apple-touch-icon":
        case "apple-touch-icon-precomposed":
        case "fluid-icon":
          isRichIcon = true;
        // fall through
        case "icon":
          if (iconAdded || link.hasAttribute("mask")) {
            // Masked icons are not supported yet.
            break;
          }

          if (!Services.prefs.getBoolPref("browser.chrome.site_icons", true)) {
            return;
          }

          if (this.iconLoader.addIconFromLink(link, isRichIcon)) {
            iconAdded = true;
            if (!isRichIcon) {
              this.seenTabIcon = true;
            }
          }
          break;
        case "search":
          if (
            Services.policies &&
            !Services.policies.isAllowed("installSearchEngine")
          ) {
            break;
          }

          if (!searchAdded && event.type == "DOMLinkAdded") {
            let type = link.type && link.type.toLowerCase();
            type = type.replace(/^\s+|\s*(?:;.*)?$/g, "");

            // Note: This protocol list should be kept in sync with
            // the one in OpenSearchEngine's install function.
            let re = /^https?:/i;
            if (
              type == "application/opensearchdescription+xml" &&
              link.title &&
              re.test(link.href)
            ) {
              let engine = { title: link.title, href: link.href };
              this.sendAsyncMessage("Link:AddSearch", {
                engine,
                url: link.ownerDocument.documentURI,
              });
              searchAdded = true;
            }
          }
          break;
        case "monetization":
          this.monetizationLoader.onLinkEvent(link.ownerDocument);
          break;
      }
    }
  }

  receiveMessage(msg) {
    switch (msg.name) {
      case "monetization:refresh:request": {
        const sessionId = msg.data;
        if (this.monetizationLoader.sessionId === sessionId) {
          this.monetizationLoader.doUpdateMonetization(this.document, true);
          return Promise.resolve({
            oldSessionId: sessionId,
            newSessionId: this.monetizationLoader.sessionId,
          });
        }
        break;
      }
      case "monetization:complete:request": {
        const event = Cu.cloneInto({ detail: msg.json }, this.document);
        this.document.dispatchEvent(
          new this.contentWindow.CustomEvent("monetizationprogress", event)
        );
        break;
      }
    }
    return null;
  }

  handleEvent(event) {
    switch (event.type) {
      case "pageshow":
        return this.onPageShow(event);
      case "pagehide":
        return this.onPageHide(event);
      case "visibilitychange":
        return this.onVisibilityChange(event);
      case "DOMHeadElementParsed":
        return this.onHeadParsed(event);
      default:
        return this.onLinkEvent(event);
    }
  }
}
