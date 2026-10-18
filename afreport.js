/* ============================================================================
   AutoForce — Completed Report PDF (auto-save to Downloads + Email button)
   ----------------------------------------------------------------------------
   Self-contained: no libraries, no network. Generates a real PDF (text +
   embedded signature JPEGs), drops it into the phone's Downloads folder with a
   sorted filename, and offers a one-tap Web-Share "Email" of the same file.

   Public API (window.AFReport):
     AFReport.save(spec)          -> Promise  (build + download + banner)
     AFReport.build(spec)         -> Promise<Blob>
     AFReport.filename(kind,name,date)
     AFReport.watchTraining(list) -> auto-fires once per released trainee
     AFReport.markReported(key)   -> remember a report was already produced
     AFReport.ready()             -> bool
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. Minimal PDF writer                                              *
   * ------------------------------------------------------------------ */

  var PAGE_W = 612, PAGE_H = 792;     // US Letter, points
  var M_L = 54, M_R = 54, M_T = 40, M_B = 46;
  var VAL_COL_MIN = 150;              // narrowest right-hand value column
  var VAL_COL_MAX = 210;              // widest a value may be before it wraps

  /* Layout metrics.  `normal` is the airy multi-page report; `compact` is the
     same document with tighter type and spacing, used by the PACE evaluation
     so a full form lands on a single sheet of paper.  Keeping both sets here
     means the two variants can never drift apart, and renderSpec() never has
     to care which one it was handed. */
  var METRICS = {
    normal: {
      mTop: 40, mBot: 46,
      logoW: 150, logoHMax: 92, logoGap: 18,
      titleSize: 19, titleDy: 16, subSize: 10, subDy: 31,
      headMin: 44, headStamp: 60, headGapLine: 10, headGap: 18,
      stampSize: 9.5, stampDy: 48, stampH: 15, stampTextDy: 44,
      metaCols: 2, metaValOff: 68, metaValPad: 6, metaSize: 10,
      metaRowH: 13, metaLineH: 12, metaGap: 8,
      blockHeadSize: 12, blockHeadDy: 4, blockHeadGap: 13, blockGap: 6,
      rowSize: 10, rowLineH: 13, rowRuleDy: 4, rowGap: 10, rowIndent: 10,
      valColMin: VAL_COL_MIN, valColMax: VAL_COL_MAX,
      valWrapIndent: 14, valWrapSize: 9.5, valWrapLineH: 12, valWrapGap: 2,
      noteSize: 9.5, noteLineH: 12, noteGap: 4,
      paraHeadSize: 12, paraHeadDy: 4, paraHeadGap: 13, paraSize: 10, paraLineH: 13, paraGap: 8,
      sigHeadSize: 12, sigHeadDy: 4, sigHeadGap: 12,
      sigPerRow: 2, sigColGap: 18, sigBoxH: 50, sigRowGap: 20, sigLabelDy: 11, sigLabelSize: 8.5, sigGap: 4,
      footSize: 9, footLineH: 11,
      minBlock: 52, minNote: 26, minPara: 40, minSig: 84,
    },
    compact: {
      mTop: 34, mBot: 38,
      logoW: 88, logoHMax: 54, logoGap: 12,
      titleSize: 15, titleDy: 13, subSize: 9, subDy: 24,
      headMin: 40, headStamp: 40, headGapLine: 8, headGap: 12,
      stampSize: 8.5, stampDy: 41, stampH: 13, stampTextDy: 37,
      metaCols: 3, metaValOff: 64, metaValPad: 5, metaSize: 9.5,
      metaRowH: 11, metaLineH: 10, metaGap: 6,
      blockHeadSize: 11, blockHeadDy: 3, blockHeadGap: 9, blockGap: 2,
      rowSize: 9.5, rowLineH: 10.5, rowRuleDy: 3, rowGap: 7, rowIndent: 8,
      valColMin: 110, valColMax: 165,
      valWrapIndent: 12, valWrapSize: 9, valWrapLineH: 10, valWrapGap: 2,
      noteSize: 9, noteLineH: 10.5, noteGap: 3,
      paraHeadSize: 11, paraHeadDy: 3, paraHeadGap: 10, paraSize: 9.5, paraLineH: 11, paraGap: 5,
      sigHeadSize: 11, sigHeadDy: 3, sigHeadGap: 10,
      sigPerRow: 2, sigColGap: 18, sigBoxH: 32, sigRowGap: 12, sigLabelDy: 9, sigLabelSize: 7.5, sigGap: 6,
      footSize: 8.5, footLineH: 9.5,
      minBlock: 34, minNote: 20, minPara: 30, minSig: 58,
    },
  };

  // Real Helvetica / Helvetica-Bold AFM advance widths (units/1000) for ASCII
  // 32..126.  The true metrics — not an approximation — are what make the
  // right-aligned value column land *exactly* on the margin and wrap at the
  // right word, so the document lines up instead of looking ragged.
  var AFM_REG = [
    278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
    1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
    667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
    333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
    556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  var AFM_BOLD = [
    278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
    975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
    667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
    333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
    611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
  // WinAnsi high bytes our document text can actually reach (em dash, quotes,
  // degree, middot, accented vowels) — Helvetica / Helvetica-Bold widths.
  var AFM_HI_REG = { 0x85:1000,0x91:333,0x92:222,0x93:333,0x94:333,0x95:350,0x96:556,
    0x97:1000,0xa0:278,0xb0:400,0xb7:278,0xe1:556,0xe9:556,0xed:278,0xf1:556,0xf3:556,0xfa:556,0xfc:556 };
  var AFM_HI_BOLD = { 0x85:1000,0x91:333,0x92:278,0x93:333,0x94:333,0x95:350,0x96:556,
    0x97:1000,0xa0:278,0xb0:400,0xb7:278,0xe1:556,0xe9:556,0xed:278,0xf1:611,0xf3:611,0xfa:611,0xfc:611 };
  function charW(ch, bold) {
    var b = winByte(ch.charCodeAt(0));   // the byte that actually gets printed
    if (b >= 32 && b <= 126) return (bold ? AFM_BOLD : AFM_REG)[b - 32] || 556;
    return (bold ? AFM_HI_BOLD : AFM_HI_REG)[b] || 556;
  }
  function textWidth(s, size, bold) {
    var w = 0;
    s = prepText(s);
    for (var i = 0; i < s.length; i++) w += charW(s.charAt(i), bold);
    return (w / 1000) * size;
  }

  // Latin-1 / WinAnsi mapping so the byte stream stays valid.
  var WIN = { 8212: 0x97, 8211: 0x96, 8216: 0x91, 8217: 0x92, 8220: 0x93, 8221: 0x94,
              8226: 0x95, 8230: 0x85, 176: 176, 183: 183, 8217: 0x92, 225: 225, 233: 233,
              8212: 0x97, 9733: 42 };
  // Characters WinAnsi simply has no byte for, expanded to plain ASCII first
  // (the app data is full of "→" in the process rules, "✓"/"★" in headings).
  var TEXT_SUBS = [
    [/\u2192/g, '->'], [/\u2190/g, '<-'], [/\u2191/g, '^'], [/\u2193/g, 'v'],
    [/\u2265/g, '>='], [/\u2264/g, '<='], [/\u2605|\u2606/g, '*'],
    [/\u2713|\u2714/g, 'v'], [/\u2192/g, '->'],
    [/\u00a0|\u2007|\u2009|\u202f|\u200a/g, ' '],
    [/[\u2709\u270d\ufe0f\u200b]/g, ''],
  ];
  function winByte(code) {
    if (code < 256) return code;
    if (code in WIN) return WIN[code];
    return 63; // '?'
  }
  function prepText(s) {
    s = String(s == null ? '' : s);
    for (var k = 0; k < TEXT_SUBS.length; k++) s = s.replace(TEXT_SUBS[k][0], TEXT_SUBS[k][1]);
    return s;
  }
  function escStr(s) {
    var out = '';
    s = prepText(s);
    for (var i = 0; i < s.length; i++) {
      var b = winByte(s.charCodeAt(i));
      var ch = String.fromCharCode(b);
      if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
      else out += ch;
    }
    return '(' + out + ')';
  }

  function Writer() {
    this.objs = [];          // objs[n-1] = array of chunks (string | Uint8Array)
    this.imgCount = 0;
  }
  Writer.prototype.put = function (chunks) { this.objs.push(chunks); return this.objs.length; };
  Writer.prototype.dict = function (s) { return [s]; };
  Writer.prototype.streamObj = function (s) {
    // s must be a latin-1 string (1 char == 1 byte) — see escStr()
    return this.put(['<< /Length ' + s.length + ' >>\nstream\n', s, '\nendstream']);
  };
  Writer.prototype.image = function (img) {
    // img = { data: Uint8Array(jpeg), w, h }
    var head = '<< /Type /XObject /Subtype /Image /Width ' + img.w + ' /Height ' + img.h +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.data.length + ' >>\nstream\n';
    this.imgCount++;
    return this.put([head, img.data, '\nendstream']);
  };
  Writer.prototype.serialize = function (catalogNo) {
    var out = [];
    var len = 0;
    function push(chunk) {
      if (typeof chunk === 'string') {
        var a = new Uint8Array(chunk.length);
        for (var i = 0; i < chunk.length; i++) a[i] = chunk.charCodeAt(i) & 0xff;
        out.push(a); len += a.length;
      } else { out.push(chunk); len += chunk.length; }
    }
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    var offsets = [];
    for (var i = 0; i < this.objs.length; i++) {
      offsets[i] = len;
      push((i + 1) + ' 0 obj\n');
      var parts = this.objs[i];
      for (var j = 0; j < parts.length; j++) push(parts[j]);
      push('\nendobj\n');
    }
    var xref = len;
    var s = 'xref\n0 ' + (this.objs.length + 1) + '\n0000000000 65535 f \n';
    for (var k = 0; k < offsets.length; k++) {
      s += ('0000000000' + offsets[k]).slice(-10) + ' 00000 n \n';
    }
    s += 'trailer\n<< /Size ' + (this.objs.length + 1) + ' /Root ' + catalogNo + ' 0 R >>\n' +
         'startxref\n' + xref + '\n%%EOF\n';
    push(s);
    return new Blob(out, { type: 'application/pdf' });
  };

  /* ---- a page canvas that emits a content stream ---- */
  // U.S. AutoForce brand navy (#0b1120) — used for the header rule + title so
  // the document reads as branded rather than as a plain text report.
  var COL_NAVY = [0.043, 0.067, 0.125];
  function Page() { this.ops = []; this.usedImages = {}; }
  function rgbOp(rgb, stroke) {
    if (!rgb) return null;
    return rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + (stroke ? ' RG ' : ' rg ');
  }
  Page.prototype.text = function (x, y, str, size, bold, gray, italic, rgb) {
    var f = bold ? '/F2' : italic ? '/F3' : '/F1';
    var col = rgbOp(rgb) || (gray ? '0.32 g' : '0 g');
    this.ops.push('BT ' + col + ' ' + f + ' ' + size + ' Tf 1 0 0 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) +
      ' Tm ' + escStr(str) + ' Tj ET');
  };
  Page.prototype.rtext = function (xRight, y, str, size, bold, gray, rgb) {
    this.text(xRight - textWidth(str, size, bold), y, str, size, bold, gray, false, rgb);
  };
  Page.prototype.line = function (x1, y1, x2, y2, w, gray, rgb) {
    this.ops.push((rgbOp(rgb, true) || (gray ? '0.78 0.78 0.78 RG ' : '0 0 0 RG ')) + (w || 0.6) + ' w ' +
      x1.toFixed(2) + ' ' + y1.toFixed(2) + ' m ' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' l S');
  };
  Page.prototype.rect = function (x, y, w, h, gray, rgb) {
    this.ops.push((rgbOp(rgb) || (gray ? '0.94 0.94 0.94 rg ' : '0 0 0 rg ')) + x.toFixed(2) + ' ' + y.toFixed(2) + ' ' +
      w.toFixed(2) + ' ' + h.toFixed(2) + ' re f');
  };
  Page.prototype.img = function (name, x, y, w, h) {
    this.usedImages[name] = true;
    this.ops.push('q ' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + x.toFixed(2) + ' ' + (y).toFixed(2) + ' cm /' + name + ' Do Q');
  };
  Page.prototype.stream = function () { return this.ops.join('\n'); };

  // Greedy word wrap.
  function wrap(str, size, bold, maxW) {
    var words = String(str == null ? '' : str).split(/\s+/).filter(function (w) { return w.length; });
    var lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + ' ' + words[i] : words[i];
      if (textWidth(t, size, bold) <= maxW || !cur) cur = t;
      else { lines.push(cur); cur = words[i]; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  /* ---- flow engine: turns a spec into pages ---- */
  function renderSpec(spec, imgs) {
    var pages = [];
    var p = new Page();
    var C = spec.compact ? METRICS.compact : METRICS.normal;
    var y = PAGE_H - C.mTop;
    var contentW = PAGE_W - M_L - M_R;
    var pageNo = 0;
    var meta = spec.meta || [];
    var title = spec.title || 'Report';
    var genDate = spec.genDate || stampDate();

    // Footer: a thin rule, the brand mark (the real logo, not the words) on the
    // left with the generation date, and the report id + page on the right.
    // Putting the provenance here keeps it off the body, so the document ends
    // on real content instead of a stray date line.
    function footer() {
      p.line(M_L, C.mBot - 12, PAGE_W - M_R, C.mBot - 12, 0.6, true);
      var fx = M_L;
      if (imgs.logo) {
        var fh = 11.5, fw = fh * (imgs.logo.w / imgs.logo.h);
        p.img('ImLogo', M_L, C.mBot - 25.5, fw, fh);
        fx = M_L + fw + 7;
      }
      var flabel = imgs.logo ? '' : 'U.S. AutoForce  ·  ';
      p.text(fx, C.mBot - 23, flabel + 'Generated ' + genDate, 7.5, false, true);
      p.rtext(PAGE_W - M_R, M_B - 23, title + (spec.date ? '  ·  ' + spec.date : '') + '  ·  Page ' + pageNo, 7.5, false, true);
    }
    function breakPage() {
      footer();
      pages.push(p);
      p = new Page();
      pageNo++;
      y = PAGE_H - C.mTop;
    }
    function need(h) { if (y - h < C.mBot) breakPage(); }
    pageNo = 1;

    /* header — the U.S. AutoForce logo image, in navy, with the brand rule
       underneath.  Losing the logo used to leave a bare text header; now the
       mark is the anchor of the page. */
    var lw = 0;
    var headH = 44;
    if (imgs.logo) {
      lw = C.logoW;
      var lh = lw * (imgs.logo.h / imgs.logo.w);
      if (lh > C.logoHMax) { lh = C.logoHMax; lw = lh * (imgs.logo.w / imgs.logo.h); }
      p.img('ImLogo', M_L, y - lh, lw, lh);
      var tx = M_L + lw + C.logoGap;
      p.text(tx, y - C.titleDy, title, C.titleSize, true, false, false, COL_NAVY);
      if (spec.subtitle) p.text(tx, y - C.subDy, spec.subtitle, C.subSize, false, true);
      headH = Math.max(lh, spec.stamp ? C.headStamp : C.headMin);
    } else {
      p.text(M_L, y - C.titleDy, title, C.titleSize, true, false, false, COL_NAVY);
      if (spec.subtitle) p.text(M_L, y - C.subDy, spec.subtitle, C.subSize, false, true);
      headH = spec.stamp ? C.headStamp : C.headMin;
    }
    // the completion stamp must show whether or not a logo was available
    if (spec.stamp) {
      var sx = imgs.logo ? (M_L + lw + 18) : M_L;
      var sw = textWidth(spec.stamp, C.stampSize, true) + 14;
      p.rect(sx, y - C.stampDy, sw, C.stampH, true);
      p.text(sx + 7, y - C.stampTextDy, spec.stamp, C.stampSize, true, false, false, COL_NAVY);
    }
    y -= headH + C.headGapLine;
    p.line(M_L, y, PAGE_W - M_R, y, 1.6, false, COL_NAVY);
    y -= C.headGap;

    /* meta grid — two columns.  The value sits at a FIXED offset so the rows
       line up as a table (label column / value column) instead of trailing
       each label by its own width. */
    if (meta.length) {
      var colW = contentW / C.metaCols;
      var valOff = C.metaValOff;                 // label column width inside each cell
      var valAvail = colW - valOff - C.metaValPad;
      for (var i = 0; i < meta.length; i += C.metaCols) {
        var cells = [];
        for (var c = 0; c < C.metaCols; c++) {
          var item = meta[i + c];
          if (!item) { cells.push(null); continue; }
          var mval = String(item[1] == null ? '' : item[1]);
          var mlbl = String(item[0] == null ? '' : item[0]);
          if (!/:\s*$/.test(mlbl)) mlbl += ':';   // labels normally arrive with the colon
          cells.push({ lbl: mlbl, lines: wrap(mval, C.metaSize, false, valAvail) });
        }
        var rowH = C.metaRowH;
        cells.forEach(function (cl) {
          if (cl && cl.lines.length > 1) rowH = Math.max(rowH, C.metaRowH + (cl.lines.length - 1) * C.metaLineH);
        });
        need(rowH + 4);
        cells.forEach(function (cl, ci) {
          if (!cl) return;
          var x = M_L + ci * colW;
          p.text(x, y, cl.lbl, C.metaSize, true);
          cl.lines.forEach(function (ln, li) { p.text(x + valOff, y - li * C.metaLineH, ln, C.metaSize); });
        });
        y -= rowH;
      }
      y -= C.metaGap;
    }

    /* blocks */
    (spec.blocks || []).forEach(function (b) {
      need(C.minBlock);   // keep the heading with at least one row (no orphan headings)
      p.text(M_L, y, b.heading, C.blockHeadSize, true, false, false, COL_NAVY);
      y -= C.blockHeadDy;
      p.line(M_L, y, PAGE_W - M_R, y, 0.8, true);
      y -= C.blockHeadGap;
      (b.rows || []).forEach(function (row) {
        var label = String(row[0] == null ? '' : row[0]);
        var val = String(row[1] == null ? '' : row[1]);
        /* The value is a right-aligned column.  A value wider than the column
           (a long ride-along comment, say) cannot be right-aligned or it runs
           back across the item label, so it is wrapped onto its own indented
           line underneath instead. */
        var valW = textWidth(val, C.rowSize, true);
        var sameLine = valW <= C.valColMax;
        var lines = wrap(label, C.rowSize, false,
          contentW - (sameLine ? Math.max(C.valColMin, valW) : C.valColMax) - 12);
        var valLines = sameLine ? [] : wrap(val, C.rowSize, false, contentW - C.valWrapIndent);
        need(lines.length * C.rowLineH + valLines.length * C.valWrapLineH + 8);
        for (var li = 0; li < lines.length; li++) {
          p.text(M_L + (li ? C.rowIndent : 0), y, lines[li], C.rowSize, false, false);
          y -= C.rowLineH;
        }
        if (sameLine) {
          y += C.rowLineH; // value aligns to the row's first line
          p.rtext(PAGE_W - M_R, y, val, C.rowSize, true);
          y -= C.rowRuleDy;
        } else {
          valLines.forEach(function (l) { p.text(M_L + C.valWrapIndent, y, l, C.valWrapSize, false, true); y -= C.valWrapLineH; });
          y -= C.valWrapGap;
        }
        p.line(M_L, y, PAGE_W - M_R, y, 0.4, true);
        y -= C.rowGap;
      });
      if (b.notes) {
        need(C.minNote);
        var nl = wrap(b.notes, C.noteSize, false, contentW);
        nl.forEach(function (l) { need(C.noteLineH); p.text(M_L, y, l, C.noteSize, false, true); y -= C.noteLineH; });
        y -= C.noteGap;
      }
      y -= C.blockGap;
    });

    /* paragraphs */
    (spec.paragraphs || []).forEach(function (par) {
      need(C.minPara);
      p.text(M_L, y, par.heading, C.paraHeadSize, true, false, false, COL_NAVY);
      y -= C.paraHeadDy;
      p.line(M_L, y, PAGE_W - M_R, y, 0.8, true);
      y -= C.paraHeadGap;
      wrap(par.text, C.paraSize, false, contentW).forEach(function (l) { need(C.paraLineH); p.text(M_L, y, l, C.paraSize); y -= C.paraLineH; });
      y -= C.paraGap;
    });

    /* signatures */
    var allSigs = spec.signatures || [];
    var sigs = [];
    for (var s0 = 0; s0 < allSigs.length; s0++) {
      if (allSigs[s0] && imgs.sigList && imgs.sigList[s0]) {
        sigs.push({ n: 'ImS' + s0, label: allSigs[s0].label, img: imgs.sigList[s0] });
      }
    }
    if (sigs.length) {
      need(C.minSig);
      p.text(M_L, y, 'Signatures', C.sigHeadSize, true, false, false, COL_NAVY);
      y -= C.sigHeadDy;
      p.line(M_L, y, PAGE_W - M_R, y, 0.8, true);
      y -= C.sigHeadGap;
      var perRow = C.sigPerRow, gap = C.sigColGap, boxW = (contentW - gap) / perRow, boxH = C.sigBoxH;
      for (var si = 0; si < sigs.length; si++) {
        var col = si % perRow;
        if (col === 0) need(boxH + C.sigRowGap + 4);
        var bx = M_L + col * (boxW + gap);
        var img = sigs[si].img;
        var iw = boxW - 8, ih = iw * (img.h / img.w);
        if (ih > boxH - 6) { ih = boxH - 6; iw = ih * (img.w / img.h); }
        p.img(sigs[si].n, bx, y - ih, iw, ih);
        p.line(bx, y - boxH, bx + boxW - 8, y - boxH, 0.7, true);
        p.text(bx, y - boxH - C.sigLabelDy, sigs[si].label, C.sigLabelSize, false, true);
        if (col === perRow - 1 || si === sigs.length - 1) y -= boxH + C.sigRowGap;
      }
      y -= C.sigGap;
    }

    /* footnotes — record content only; provenance lives in the footer.
       An audit line can be long, so wrap it rather than letting it run off
       the right edge of the page. */
    (spec.footnotes || []).forEach(function (f) {
      var fl = wrap(f, C.footSize, false, contentW);
      need(C.footLineH * fl.length + 2);          // keep a single footnote together
      fl.forEach(function (l) { p.text(M_L, y, l, C.footSize, false, true); y -= C.footLineH; });
    });

    footer();
    pages.push(p);
    return pages;
  }

  /* ------------------------------------------------------------------ *
   * 2. Image encoding                                                   *
   * ------------------------------------------------------------------ */

  function dataUrlToBytes(u) {
    var b64 = String(u || '').split(',')[1] || '';
    var bin = atob(b64);
    var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function jpegImg(dataUrl) {
    return new Promise(function (res) {
      try {
        var probe = new Image();
        probe.onload = function () {
          var c = document.createElement('canvas');
          c.width = (probe.naturalWidth || probe.width) || 600;
          c.height = (probe.naturalHeight || probe.height) || 200;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(probe, 0, 0);
          var j = c.toDataURL('image/jpeg', 0.85);
          res({ data: dataUrlToBytes(j), w: c.width, h: c.height });
        };
        probe.onerror = function () { res(null); };
        probe.src = dataUrl;
      } catch (e) { res(null); }
    });
  }
  // Read width/height straight out of the JPEG's SOF marker.  The logo then
  // embeds from the bytes alone, with no dependency on an Image decode that a
  // mobile webview can silently drop (which left the report with no logo).
  function jpegSize(a) {
    var i = 2;
    while (i + 9 < a.length) {
      if (a[i] !== 0xFF) { i++; continue; }
      var m = a[i + 1];
      if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (a[i + 5] << 8) | a[i + 6], w: (a[i + 7] << 8) | a[i + 8] };
      }
      i += 2 + ((a[i + 2] << 8) | a[i + 3]);
    }
    return null;
  }
  function passthroughImg(dataUrl) {
    // already a JPEG (e.g. the app's AF_LOGO) — embed the bytes untouched
    return new Promise(function (res) {
      try {
        var bytes = dataUrlToBytes(dataUrl);
        var dim = jpegSize(bytes);
        if (dim && dim.w && dim.h) return res({ data: bytes, w: dim.w, h: dim.h, direct: true });
        var probe = new Image();
        probe.onload = function () {
          res({ data: bytes, w: probe.naturalWidth || probe.width, h: probe.naturalHeight || probe.height, direct: true });
        };
        probe.onerror = function () { res(null); };
        probe.src = dataUrl;
      } catch (e) { res(null); }
    });
  }
  // the PDF writer embeds bytes as DCTDecode, so only real JPEGs may pass
  // through untouched — anything else is re-encoded through a canvas.
  function isJpeg(u) { return /^data:image\/jpe?g[;,]/i.test(String(u || '')); }

  /* ------------------------------------------------------------------ *
   * 3. Build                                                            *
   * ------------------------------------------------------------------ */

  function buildPdf(spec) {
    var logoJob = spec.logo ? (isJpeg(spec.logo) ? passthroughImg(spec.logo) : jpegImg(spec.logo)) : Promise.resolve(null);
    var sigJobs = (spec.signatures || []).map(function (s) {
      return (s && s.image) ? jpegImg(s.image) : Promise.resolve(null);
    });
    return Promise.all([logoJob].concat(sigJobs)).then(function (res) {
      var imgs = { sigList: [] };
      if (res[0]) imgs.logo = res[0];
      (spec.signatures || []).forEach(function (s, i) { imgs.sigList[i] = res[i + 1] || null; });

      var pages = renderSpec(spec, imgs);

      var W = new Writer();
      var F1 = W.put(W.dict('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
      var F2 = W.put(W.dict('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
      var F3 = W.put(W.dict('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>'));

      var imgNums = {};
      if (imgs.logo) imgNums['ImLogo'] = W.image(imgs.logo);
      (imgs.sigList || []).forEach(function (im, i) {
        if (im) imgNums['ImS' + i] = W.image(im);
      });

      var pageNums = [];
      pages.forEach(function (pg) {
        var cNum = W.streamObj(pg.stream());
        var res = '<< /Font << /F1 ' + F1 + ' 0 R /F2 ' + F2 + ' 0 R /F3 ' + F3 + ' 0 R >>';
        if (Object.keys(imgNums).length) {
          res += ' /XObject << ';
          for (var i2 in imgNums) res += '/' + i2 + ' ' + imgNums[i2] + ' 0 R ';
          res += '>>';
        }
        res += ' >>';
        var pNum = W.put(W.dict('<< /Type /Page /Parent __PAGES__ /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H +
          '] /Resources ' + res + ' /Contents ' + cNum + ' 0 R >>'));
        pageNums.push(pNum);
      });

      var pagesNo = W.put(W.dict('<< /Type /Pages /Kids [' + pageNums.map(function (x) { return x + ' 0 R'; }).join(' ') +
        '] /Count ' + pageNums.length + ' >>'));
      // patch parent refs
      pageNums.forEach(function (pn) {
        W.objs[pn - 1] = [W.objs[pn - 1][0].replace('__PAGES__', pagesNo + ' 0 R')];
      });
      var catNo = W.put(W.dict('<< /Type /Catalog /Pages ' + pagesNo + ' 0 R >>'));
      return W.serialize(catNo);
    });
  }

  /* ------------------------------------------------------------------ *
   * 4. Filename / download / share                                       *
   * ------------------------------------------------------------------ */

  function safe(s) {
    return String(s || '').replace(/[\/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
  }
  function filename(kind, name, date) {
    var n = safe(name) || 'Driver';
    var d = safe(date) || todayISO();
    return 'AutoForce ' + kind + ' - ' + n + ' - ' + d + '.pdf';
  }
  function todayISO() {
    var t = new Date();
    return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // "Oct 17, 2026" — the generation stamp shown in the footer.
  function stampDate() {
    var t = new Date();
    return MONTHS[t.getMonth()] + ' ' + t.getDate() + ', ' + t.getFullYear();
  }

  function downloadBlob(blob, fname) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = fname; a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) { return false; }
  }

  var last = null;   // { blob, fname, kind, name, date }
  var lastFiles = []; // array of { blob, fname, kind, name, date }

  // Recipient hint for the "Email" button. This is only used by the mailto /
  // no-share fallbacks: the normal phone path opens the share sheet, and the
  // user picks the recipient (Compliance Group) there. Set
  // window.AF_COMPLIANCE_EMAIL before this module loads to pre-address the
  // fallback.
  var COMPLIANCE_TO = (typeof window !== 'undefined' && window.AF_COMPLIANCE_EMAIL) || '';

  function canShareFiles(files) {
    try { return !!(navigator.canShare && navigator.canShare({ files: files })); } catch (e) { return false; }
  }

  function buildFileList(items) {
    var arr = [];
    (items || []).forEach(function (it) {
      if (it && it.blob) arr.push(new File([it.blob], it.fname || 'report.pdf', { type: 'application/pdf' }));
    });
    return arr;
  }

  function shareLast(opts) {
    opts = opts || {};
    var items = (lastFiles && lastFiles.length) ? lastFiles.slice() : (last ? [last] : []);
    if (!items.length) { toast('Nothing to email yet — save a completed report first.'); return; }
    var files = buildFileList(items);
    var names = items.map(function (x) { return x.fname; }).join(', ');
    var kinds = items.map(function (x) { return x.kind || 'Report'; }).join(', ');
    var name = items[0] && items[0].name ? ' — ' + items[0].name : '';
    var date = items[0] && items[0].date ? ' (' + items[0].date + ')' : '';
    var subj = opts.subject || ('AutoForce ' + kinds + ' report' + name + date);
    var to = opts.to || COMPLIANCE_TO || '';
    var body = opts.body || ('Completed ' + kinds + ' report' + name + date + '. PDF' + (files.length > 1 ? 's' : '') + ' attached.');
    var payload = {
      files: files,
      title: subj,
      text: body,
    };
    if (canShareFiles(files)) {
      // Try to hint mailto if supported? navigator.share doesn't take mailto directly; apps may ignore.
      try {
        if (navigator.share) {
          navigator.share(payload).catch(function () {});
          return;
        }
      } catch (e) {}
    }
    if (navigator.share) {
      navigator.share({ title: subj, text: body + '\n\nSaved in Downloads: ' + names })
        .catch(function () {});
      return;
    }
    var mailto = 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(body + '\n\nFiles: ' + names);
    try { window.location.href = mailto; return; } catch (e) {}
    alert('Emailing is not supported by this browser.\n\nOpen your Files / Downloads app and email:\n\n' + names + '\n\nTo: ' + (to || 'Compliance Group') + '\nSubject: ' + subj);
  }

  function shareFiles(items, opts) {
    lastFiles = (items || []).slice();
    if (lastFiles.length === 1 && lastFiles[0]) last = lastFiles[0];
    var okAll = true;
    lastFiles.forEach(function (it) {
      if (it && it.blob) {
        try { downloadBlob(it.blob, it.fname); } catch (e) { okAll = false; }
      }
    });
    banner(true, lastFiles.map(function (x) { return x.fname; }).join(', '));
    shareLast(opts);
  }

  function toast(msg) {
    if (typeof window.__afToast === 'function') { window.__afToast(msg); return; }
    try {
      var t = document.createElement('div');
      t.textContent = msg;
      t.setAttribute('style', 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:99999;' +
        'background:#0b1120;color:#fff;padding:10px 16px;border-radius:10px;font:600 13px system-ui,sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:86vw;text-align:center');
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 3200);
    } catch (e) {}
  }

  /* ---- banner shown after a report is saved ---- */
  var CSS = [
    '.afrep-card{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:99998;width:min(560px,94vw);',
    'background:#0b1120;color:#f3f4f6;border:1px solid rgba(255,255,255,.14);border-radius:14px;',
    'box-shadow:0 16px 40px rgba(0,0,0,.45);padding:12px 14px;font:400 13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;',
    'display:flex;gap:12px;align-items:flex-start}',
    '.afrep-card .afrep-ic{font-size:20px;line-height:1}',
    '.afrep-card .afrep-body{flex:1;min-width:0}',
    '.afrep-card .afrep-t{font-weight:800;font-size:13px}',
    '.afrep-card .afrep-f{font:600 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;opacity:.92;margin-top:2px}',
    '.afrep-card .afrep-s{opacity:.72;font-size:12px;margin-top:3px}',
    '.afrep-card .afrep-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}',
    '.afrep-btn{border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:9px;padding:7px 12px;font:700 12.5px system-ui,sans-serif;cursor:pointer}',
    '.afrep-btn.ghost{background:transparent;border-color:rgba(255,255,255,.35);color:#e5e7eb}',
    '.afrep-x{margin-left:auto;background:transparent;border:0;color:#9ca3af;font:700 16px system-ui,sans-serif;cursor:pointer;line-height:1;padding:2px 4px}',
  ].join('');
  function injectCss() {
    if (document.getElementById('afrep-css')) return;
    var st = document.createElement('style');
    st.id = 'afrep-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function banner(saved, fname) {
    injectCss();
    var old = document.getElementById('afrep-banner');
    if (old) old.remove();
    var hasMany = (lastFiles && lastFiles.length > 1);
    var items = (hasMany ? lastFiles : (last ? [last] : []));
    var names = items.map(function (x) { return x.fname; }).join(', ');
    var label = hasMany ? (items.length + ' PDFs') : (fname || names);
    if (hasMany && names.length > 90) label = (items.length + ' PDFs');
    var card = document.createElement('div');
    card.id = 'afrep-banner';
    card.className = 'afrep-card';
    card.innerHTML =
      '<div class="afrep-ic">📄</div><div class="afrep-body">' +
      '<div class="afrep-t">' + (saved ? (hasMany ? items.length + ' Reports saved to Downloads' : 'Report saved to Downloads') : 'Report ready') + '</div>' +
      '<div class="afrep-f">' + (hasMany ? names : (fname || names)) + '</div>' +
      '<div class="afrep-s">' + (saved ? 'Find them in your Files / Downloads app, or email them now.' : 'Tap Save PDF to put it in Downloads.') + '</div>' +
      '<div class="afrep-row"></div></div>' +
      '<button class="afrep-x" aria-label="Close">✕</button>';
    var row = card.querySelector('.afrep-row');
    function mk(label, fn, ghost) {
      var b = document.createElement('button');
      b.className = 'afrep-btn' + (ghost ? ' ghost' : '');
      b.textContent = label;
      b.onclick = fn;
      row.appendChild(b);
      return b;
    }
    var hasMany = (lastFiles && lastFiles.length > 1);
    mk(hasMany ? '✉️  Email both to Compliance Group' : '✉️  Email to Compliance Group', function () {
      if (lastFiles && lastFiles.length > 1) shareFiles(lastFiles);
      else shareLast();
    });
    mk('💾  Save PDF' + (hasMany ? 's' : ''), function () {
      var items = (lastFiles && lastFiles.length) ? lastFiles : (last ? [last] : []);
      items.forEach(function (it) { if (it) downloadBlob(it.blob, it.fname); });
      toast('Saved' + (items.length > 1 ? ' ' + items.length + ' files' : ': ' + (items[0] ? items[0].fname : '')));
    }, true);
    card.querySelector('.afrep-x').onclick = function () { card.remove(); };
    document.body.appendChild(card);
  }

  /* ---- the main entry point ---- */
  function save(spec) {
    return buildPdf(spec).then(function (blob) {
      var fname = spec.filename || filename(spec.kind || 'Report', spec.name, spec.date);
      last = { blob: blob, fname: fname, kind: spec.kind || 'Report', name: spec.name, date: spec.date };
      var ok = downloadBlob(blob, fname);
      banner(ok, fname);
      return { blob: blob, filename: fname };
    }).catch(function (e) {
      toast('Could not build the PDF: ' + (e && e.message ? e.message : e));
      return null;
    });
  }

  /* ------------------------------------------------------------------ *
   * 5. Auto-detect a released trainee (fires once per release date)      *
   * ------------------------------------------------------------------ */
  var REPORTED_KEY = 'afReported_v1';
  var _reported = null;
  function reported() {
    if (_reported) return _reported;
    try { _reported = JSON.parse(localStorage.getItem(REPORTED_KEY) || '{}') || {}; }
    catch (e) { _reported = {}; }
    return _reported;
  }
  function markReported(key, clear) {
    if (!key) return;
    var r = reported();
    if (clear) {
      delete r[key];
      try { localStorage.setItem(REPORTED_KEY, JSON.stringify(r)); } catch (e) {}
      return;
    }
    r[key] = Date.now();
    try { localStorage.setItem(REPORTED_KEY, JSON.stringify(r)); } catch (e) {}
  }
  // On first ever run, treat everything already complete as "already reported"
  // so shipping this feature does not dump a pile of old PDFs.
  var SEEDED_KEY = 'afReportedSeeded_v1';
  function seedOnce(list, isComplete, makeKey) {
    try {
      if (localStorage.getItem(SEEDED_KEY)) return;
      (list || []).forEach(function (x) { if (isComplete(x)) markReported(makeKey(x)); });
      localStorage.setItem(SEEDED_KEY, '1');
    } catch (e) {}
  }

  /* spec builders are provided by each app (they know their own data shape) */
  function watchTraining(list, opts) {
    opts = opts || {};
    var isComplete = opts.isComplete || function (t) {
      return !!(t && t.milestones && t.milestones['Released / sign-off'] && t.milestones['Released / sign-off'].date);
    };
    var makeKey = opts.key || function (t) { return 'train:' + (t.id || t.name) + ':' + (t.milestones['Released / sign-off'].date || ''); };
    var buildSpec = opts.spec;
    seedOnce(list, isComplete, makeKey);
    if (!buildSpec) return;
    (list || []).forEach(function (t) {
      if (!isComplete(t)) return;
      var key = makeKey(t);
      if (reported()[key]) return;
      markReported(key);
      // go through the public API so an app (or a test) can intercept the save
      try { (window.AFReport || {}).save ? window.AFReport.save(buildSpec(t)) : save(buildSpec(t)); } catch (e) {}
    });
  }

  window.AFReport = {
    save: save,
    build: buildPdf,
    filename: filename,
    shareLast: shareLast,
    shareFiles: shareFiles,
    downloadBlob: downloadBlob,
    toast: toast,
    watchTraining: watchTraining,
    markReported: markReported,
    seen: function (key) { return !!reported()[key]; },
    ready: function () { return true; },
  };
})();
