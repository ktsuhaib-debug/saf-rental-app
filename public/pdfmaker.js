/**
 * Turns the app's agreement / statement HTML into a PDF on the phone.
 * The browser lays the page out (in a hidden frame, A4 width), then every word, line, border and
 * image is drawn at the same place into a PDF with pdf-lib. Text stays real text (searchable, sharp).
 * Rows and headings are never cut in half across pages.
 */
(function () {
  var PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 36; // A4 in points, half-inch margins
  var PX = 0.75;                                     // 1 CSS px = 0.75 pt
  var CONTENT_W = Math.round((PAGE_W - 2 * MARGIN) / PX), PAGE_PX = (PAGE_H - 2 * MARGIN) / PX;
  var libPromise = null;

  function loadLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (!libPromise) libPromise = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'vendor/pdf-lib.min.js';
      s.onload = function () { window.PDFLib ? res(window.PDFLib) : rej(new Error('The PDF maker did not load.')); };
      s.onerror = function () { libPromise = null; rej(new Error('The PDF maker could not load. Check the internet and try again.')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function frameFor(html) {
    return new Promise(function (res) {
      var f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + CONTENT_W + 'px;height:1200px;border:0;opacity:0;pointer-events:none';
      f.onload = function () {
        var d = f.contentDocument;
        var st = d.createElement('style'); st.textContent = 'html,body{margin:0!important;padding:0!important;width:' + CONTENT_W + 'px;background:#fff}';
        d.head.appendChild(st);
        var imgs = Array.prototype.slice.call(d.images);
        Promise.all(imgs.map(function (im) { return im.complete ? null : new Promise(function (r) { im.onload = im.onerror = r; }); })).then(function () { res(f); });
      };
      f.srcdoc = html;
      document.body.appendChild(f);
    });
  }

  /** Push rows, headings, paragraphs and list items that would be cut by a page end onto the next page. */
  function paginate(d) {
    var atoms = Array.prototype.slice.call(d.body.querySelectorAll('tr, h1, h2, p, li'));
    atoms.forEach(function (el, i) {
      var r = el.getBoundingClientRect(), top = r.top + d.defaultView.scrollY, bottom = top + r.height;
      if (r.height <= 0 || r.height >= PAGE_PX) return;
      var page = Math.floor(top / PAGE_PX), end = (page + 1) * PAGE_PX;
      // Keep a heading with the first line of what follows it.
      if (el.tagName === 'H2' && bottom > end - 40 && bottom <= end) bottom = end + 1;
      if (bottom <= end) return;
      var gap = end - top + 2;
      if (el.tagName === 'TR') {
        var sp = d.createElement('tr'), td = d.createElement('td');
        td.colSpan = 99; td.style.cssText = 'height:' + gap + 'px;padding:0!important;border:0!important';
        sp.appendChild(td); el.parentNode.insertBefore(sp, el);
      } else {
        var cs = d.defaultView.getComputedStyle(el);
        el.style.marginTop = (parseFloat(cs.marginTop) + gap) + 'px';
      }
    });
  }

  function rgb(str) {
    var m = String(str || '').match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return [m[1] / 255, m[2] / 255, m[3] / 255];
  }

  // The rupee sign is not in the standard PDF fonts, so it is drawn as a small shape.
  var RUPEE = 'M 70 80 L 500 80 M 70 230 L 500 230 M 150 80 C 430 80 430 400 150 400 L 110 400 L 440 760';

  function bytesOf(src) {
    if (/^data:/.test(src)) {
      var b = atob(src.split(',')[1]), a = new Uint8Array(b.length);
      for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
      return Promise.resolve(a);
    }
    return fetch(src, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('image'); return r.arrayBuffer(); }).then(function (x) { return new Uint8Array(x); });
  }

  function toB64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  function fromHtml(html, opts) {
    opts = opts || {};
    return Promise.all([loadLib(), frameFor(html)]).then(function (x) {
      var L = x[0], frame = x[1], d = frame.contentDocument, win = d.defaultView;
      frame.style.height = Math.ceil(d.documentElement.scrollHeight + 50) + 'px';
      paginate(d);
      frame.style.height = Math.ceil(d.documentElement.scrollHeight + 50) + 'px';
      return L.PDFDocument.create().then(function (pdf) {
        pdf.setTitle(opts.title || d.title || 'Document');
        pdf.setCreator('SAF Rental');
        return Promise.all([pdf.embedFont(L.StandardFonts.Helvetica), pdf.embedFont(L.StandardFonts.HelveticaBold)]).then(function (fonts) {
          var pages = [], ops = [], okChar = {};
          function pageAt(i) { while (pages.length <= i) pages.push(pdf.addPage([PAGE_W, PAGE_H])); return pages[i]; }
          function place(topPx) { var p = Math.max(0, Math.floor(topPx / PAGE_PX)); return { page: p, y: topPx - p * PAGE_PX }; }
          function X(px) { return MARGIN + px * PX; }
          function Y(px) { return PAGE_H - MARGIN - px * PX; }
          function safe(font, ch) {
            var k = font.name + ch;
            if (okChar[k] === undefined) { try { font.encodeText(ch); okChar[k] = true; } catch (e) { okChar[k] = false; } }
            return okChar[k];
          }
          function clean(font, s) {
            return s.replace(/→/g, '->').replace(/←/g, '<-').split('').map(function (ch) { return ch === '₹' || safe(font, ch) ? ch : '?'; }).join('');
          }

          function firstTextRect(el) {
            var w = d.createTreeWalker(el, 4, null), t, rg = d.createRange();
            while ((t = w.nextNode())) { var m = /\S/.exec(t.nodeValue); if (!m) continue; rg.setStart(t, m.index); rg.setEnd(t, m.index + 1); var rs = rg.getClientRects(); if (rs.length) return rs[0]; }
            return null;
          }
          var all = d.body.querySelectorAll('*');
          // 1. Backgrounds and borders
          Array.prototype.forEach.call(all, function (el) {
            var cs = win.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            var r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return;
            var top = r.top + win.scrollY, at = place(top);
            var bg = rgb(cs.backgroundColor);
            if (bg && !(bg[0] === 1 && bg[1] === 1 && bg[2] === 1)) ops.push({ page: at.page, fn: function (pg) { pg.drawRectangle({ x: X(r.left), y: Y(at.y + r.height), width: r.width * PX, height: r.height * PX, color: L.rgb(bg[0], bg[1], bg[2]) }); } });
            ['Top', 'Bottom', 'Left', 'Right'].forEach(function (side) {
              var w = parseFloat(cs['border' + side + 'Width']); if (!w || cs['border' + side + 'Style'] === 'none') return;
              var c = rgb(cs['border' + side + 'Color']); if (!c) return;
              var box = side === 'Top' ? [r.left, at.y, r.width, w] : side === 'Bottom' ? [r.left, at.y + r.height - w, r.width, w] : side === 'Left' ? [r.left, at.y, w, r.height] : [r.right - w, at.y, w, r.height];
              ops.push({ page: at.page, fn: function (pg) { pg.drawRectangle({ x: X(box[0]), y: Y(box[1] + box[3]), width: box[2] * PX, height: box[3] * PX, color: L.rgb(c[0], c[1], c[2]) }); } });
            });
            // Numbers of numbered lists (the browser draws them outside the text)
            if (el.tagName === 'LI' && el.parentNode && el.parentNode.tagName === 'OL') {
              var n = Array.prototype.indexOf.call(el.parentNode.children, el) + 1, fs = parseFloat(cs.fontSize);
              var col = rgb(cs.color) || [0, 0, 0], first = firstTextRect(el) || r;
              var fat = place(first.top + win.scrollY), fbase = fat.y + (first.height - fs * 1.117) / 2 + fs * 0.905;
              ops.push({ page: fat.page, fn: function (pg) { var s = n + '.', w = fonts[0].widthOfTextAtSize(s, fs * PX); pg.drawText(s, { x: X(r.left) - w - 4, y: Y(fbase), size: fs * PX, font: fonts[0], color: L.rgb(col[0], col[1], col[2]) }); } });
            }
          });

          // 2. Text, word by word, at the place the browser put it
          var walker = d.createTreeWalker(d.body, 4, null), node, range = d.createRange();
          while ((node = walker.nextNode())) {
            var p = node.parentElement, cs = p && win.getComputedStyle(p);
            if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || /^(STYLE|SCRIPT|TITLE)$/.test(p.tagName)) continue;
            var fs = parseFloat(cs.fontSize), bold = (parseInt(cs.fontWeight, 10) || 400) >= 600, font = fonts[bold ? 1 : 0];
            var col = rgb(cs.color) || [0, 0, 0], upper = cs.textTransform === 'uppercase';
            var text = node.nodeValue, re = /\S+/g, m;
            while ((m = re.exec(text))) {
              range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
              var rects = range.getClientRects(); if (!rects.length) continue;
              var rr = rects[0]; if (rr.width <= 0) continue;
              var word = upper ? m[0].toUpperCase() : m[0];
              (function (word, rr, fs, font, col) {
                var top = rr.top + win.scrollY, at = place(top);
                // Baseline from the line box (Arial-like fonts: ascent .905 of 1.117 em)
                var base = at.y + (rr.height - fs * 1.117) / 2 + fs * 0.905;
                ops.push({ page: at.page, fn: function (pg) {
                  var size = fs * PX, s = clean(font, word), parts = s.split('₹');
                  var natural = parts.reduce(function (w, t) { return w + font.widthOfTextAtSize(t, size); }, 0) + (parts.length - 1) * size * 0.556;
                  if (natural > rr.width * PX * 1.02) size = size * rr.width * PX / natural; // never run into the next column
                  var x = X(rr.left), y = Y(base), color = L.rgb(col[0], col[1], col[2]);
                  parts.forEach(function (t, i) {
                    if (i > 0) {
                      pg.drawSvgPath(RUPEE, { x: x, y: y + size * 0.72, scale: size / 1000, borderColor: color, borderWidth: Math.max(0.5, size * 0.075) });
                      x += size * 0.556;
                    }
                    if (t) { pg.drawText(t, { x: x, y: y, size: size, font: font, color: color }); x += font.widthOfTextAtSize(t, size); }
                  });
                } });
              })(word, rr, fs, font, col);
            }
          }

          // 3. Images (logo, signature)
          var imgs = Array.prototype.slice.call(d.images).filter(function (im) { return im.naturalWidth > 0; });
          return Promise.all(imgs.map(function (im) {
            return bytesOf(im.currentSrc || im.src).then(function (b) {
              var png = b[0] === 0x89 && b[1] === 0x50;
              return (png ? pdf.embedPng(b) : pdf.embedJpg(b)).then(function (e) {
                var r = im.getBoundingClientRect(), at = place(r.top + win.scrollY);
                ops.push({ page: at.page, fn: function (pg) { pg.drawImage(e, { x: X(r.left), y: Y(at.y + r.height), width: r.width * PX, height: r.height * PX }); } });
              });
            }).catch(function () { /* a missing image is left out */ });
          })).then(function () {
            pageAt(ops.reduce(function (m, o) { return Math.max(m, o.page); }, 0)); // no empty pages at the end
            ops.forEach(function (o) { o.fn(pageAt(o.page)); });
            return pdf.save();
          });
        });
      });
    }).then(function (bytes) {
      var f = document.querySelectorAll('iframe[aria-hidden="true"]'); f.forEach(function (x) { if (x.srcdoc) x.remove(); });
      return bytes;
    }, function (e) {
      var f = document.querySelectorAll('iframe[aria-hidden="true"]'); f.forEach(function (x) { if (x.srcdoc) x.remove(); });
      throw e;
    });
  }

  window.PdfMaker = { fromHtml: fromHtml, toB64: toB64 };
})();
