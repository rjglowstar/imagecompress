
var Imgmin = (function () {
  'use strict';

  var MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  var MAX_CANVAS_SIDE = 16384;
  var MAX_CANVAS_AREA = 268435456;

  function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  var THUMB_MAX = 480;

  function thumbSize(width, height) {
    var scale = Math.min(1, THUMB_MAX / Math.max(width, height));
    if (scale >= 1) return null;
    return {
      w: Math.max(1, Math.round(width * scale)),
      h: Math.max(1, Math.round(height * scale))
    };
  }

  function thumbFromSource(source, width, height) {
    var size = thumbSize(width, height);
    if (!size) return Promise.resolve(null);
    var canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.drawImage(source, 0, 0, size.w, size.h);
    return toBlob(canvas, MIME.jpeg, 0.82).then(function (blob) {
      releaseCanvas(canvas);
      return blob;
    }, function () {
      releaseCanvas(canvas);
      return null;
    });
  }

  function thumbFromBlob(blob, width, height) {
    var size = thumbSize(width, height);
    if (!size || typeof createImageBitmap !== 'function') return Promise.resolve(null);
    return createImageBitmap(blob, {
      resizeWidth: size.w, resizeHeight: size.h, resizeQuality: 'high'
    }).then(function (bitmap) {
      var canvas = document.createElement('canvas');
      canvas.width = size.w;
      canvas.height = size.h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      return toBlob(canvas, MIME.jpeg, 0.82).then(function (out) {
        releaseCanvas(canvas);
        return out;
      }, function () {
        releaseCanvas(canvas);
        return null;
      });
    }).catch(function () { return null; });
  }

  var webpSupported = null;
  function supportsWebP() {
    if (webpSupported === null) {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      webpSupported = c.toDataURL(MIME.webp).indexOf('data:' + MIME.webp) === 0;
    }
    return webpSupported;
  }

  var canDeflate = typeof CompressionStream === 'function';

  function loadSource(file) {
    if (typeof createImageBitmap === 'function') {
      // from-image bakes the EXIF rotation into the pixels. Without it a phone
      // photo that relies on the Orientation tag comes out sideways, because
      // the tag does not survive re-encoding.
      return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bitmap) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: function () { if (bitmap.close) bitmap.close(); }
        };
      }).catch(function () { return loadViaImageElement(file); });
    }
    return loadViaImageElement(file);
  }

  function loadViaImageElement(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.src = url;

    var ready = img.decode ? img.decode() : new Promise(function (resolve, reject) {
      img.onload = resolve;
      img.onerror = function () { reject(new Error('Could not decode image')); };
    });
    return ready.then(function () {
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: function () { URL.revokeObjectURL(url); }
      };
    }).catch(function (err) {
      URL.revokeObjectURL(url);
      throw err;
    });
  }

  function toBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        blob ? resolve(blob) : reject(new Error('Encoding to ' + mime + ' failed'));
      }, mime, quality);
    });
  }

  // Re-encoding through a canvas keeps nothing but pixels: the EXIF block is
  // dropped and the JFIF header comes back with units=0 (pixel aspect ratio
  // only), leaving the file with no resolution at all. Both are read off the
  // source here and written back onto the encoded result.
  var DEFAULT_DENSITY = { units: 1, x: 96, y: 96 };
  var META_SCAN = 262144;

  function blobBytes(blob) {
    var buf = blob.arrayBuffer
      ? blob.arrayBuffer()
      : new Response(blob).arrayBuffer();
    return buf.then(function (b) { return new Uint8Array(b); });
  }

  // Walks the marker segments ahead of the scan data. visit() gets the marker
  // byte, its offset and the full segment length; returning true stops the walk
  // and yields that offset. -1 means the walk ran out of segments.
  function scanSegments(bytes, visit) {
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return -1;
    var i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xFF) return -1;
      var marker = bytes[i + 1];
      if (marker === 0xFF) { i++; continue; }            // fill byte
      if (marker === 0xD8 || marker === 0x01 ||
          (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) return -1;  // scan data, too late
      var len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2 || i + 2 + len > bytes.length) return -1;
      if (visit(marker, i, len + 2)) return i;
      i += 2 + len;
    }
    return -1;
  }

  function findJfifApp0(bytes) {
    return scanSegments(bytes, function (marker, at, total) {
      return marker === 0xE0 && total >= 18 &&
        bytes[at + 4] === 0x4A && bytes[at + 5] === 0x46 &&
        bytes[at + 6] === 0x49 && bytes[at + 7] === 0x46 && bytes[at + 8] === 0x00;
    });
  }

  function findExifApp1(bytes) {
    return scanSegments(bytes, function (marker, at, total) {
      return marker === 0xE1 && total > 10 &&
        bytes[at + 4] === 0x45 && bytes[at + 5] === 0x78 &&
        bytes[at + 6] === 0x69 && bytes[at + 7] === 0x66 && bytes[at + 8] === 0x00;
    });
  }

  var TAG_ORIENTATION = 0x0112, TAG_XRES = 0x011A;
  var TAG_YRES = 0x011B, TAG_RESUNIT = 0x0128;
  var TAG_THUMB_AT = 0x0201, TAG_THUMB_LEN = 0x0202;

  // The TIFF block inside an APP1 segment: 2 marker + 2 length + "Exif\0\0".
  function tiffView(seg) {
    var tiff = 10;
    if (seg.length < tiff + 8) return null;
    var le = seg[tiff] === 0x49 && seg[tiff + 1] === 0x49;
    if (!le && !(seg[tiff] === 0x4D && seg[tiff + 1] === 0x4D)) return null;
    var dv = new DataView(seg.buffer, seg.byteOffset, seg.length);
    if (dv.getUint16(tiff + 2, le) !== 42) return null;
    return {
      dv: dv, le: le, tiff: tiff, end: seg.length,
      ifd0: dv.getUint32(tiff + 4, le)
    };
  }

  // Calls onEntry(tag, entryOffset) for every entry, returns the offset holding
  // the pointer to the following IFD, or -1 if the directory does not fit.
  function walkIfd(v, ifdOffset, onEntry) {
    var base = v.tiff + ifdOffset;
    if (ifdOffset <= 0 || base + 2 > v.end) return -1;
    var count = v.dv.getUint16(base, v.le);
    var nextAt = base + 2 + count * 12;
    if (nextAt + 4 > v.end) return -1;
    for (var k = 0; k < count; k++) {
      var e = base + 2 + k * 12;
      onEntry(v.dv.getUint16(e, v.le), e);
    }
    return nextAt;
  }

  function rationalAt(v, entry) {
    var at = v.tiff + v.dv.getUint32(entry + 8, v.le);
    if (at + 8 > v.end) return 0;
    var den = v.dv.getUint32(at + 4, v.le);
    return den ? v.dv.getUint32(at, v.le) / den : 0;
  }

  // Copies EXIF through with two corrections: the orientation tag is reset,
  // because the rotation is already baked into the pixels and applying it twice
  // would show the photo sideways; and the embedded thumbnail - the only bulky
  // part of a typical APP1 - is unlinked, and trimmed when it trails the block.
  function normalizeExif(seg) {
    var v = tiffView(seg);
    if (!v) return { bytes: seg, density: null };

    var res = { x: 0, y: 0, unit: 2 };
    var nextAt = walkIfd(v, v.ifd0, function (tag, e) {
      if (tag === TAG_ORIENTATION) v.dv.setUint16(e + 8, 1, v.le);
      else if (tag === TAG_XRES) res.x = rationalAt(v, e);
      else if (tag === TAG_YRES) res.y = rationalAt(v, e);
      else if (tag === TAG_RESUNIT) res.unit = v.dv.getUint16(e + 8, v.le);
    });
    if (nextAt < 0) return { bytes: seg, density: null };

    var cut = 0;
    var ifd1 = v.dv.getUint32(nextAt, v.le);
    if (ifd1 > 0) {
      var thumb = { at: 0, len: 0 };
      walkIfd(v, ifd1, function (tag, e) {
        if (tag === TAG_THUMB_AT) thumb.at = v.dv.getUint32(e + 8, v.le);
        else if (tag === TAG_THUMB_LEN) thumb.len = v.dv.getUint32(e + 8, v.le);
      });
      v.dv.setUint32(nextAt, 0, v.le);
      var thumbEnd = v.tiff + thumb.at + thumb.len;
      if (thumb.at > 0 && thumb.len > 0 &&
          thumbEnd <= v.end && thumbEnd >= v.end - 16) {
        cut = v.tiff + thumb.at;
      }
    }

    var bytes = seg;
    if (cut > 12 && cut < seg.length) {
      bytes = seg.slice(0, cut);
      bytes[2] = ((cut - 2) >> 8) & 0xFF;
      bytes[3] = (cut - 2) & 0xFF;
    }

    // EXIF unit 2 is inches and 3 is centimetres; JFIF calls those 1 and 2.
    var units = res.unit === 3 ? 2 : res.unit === 2 ? 1 : 0;
    var density = (units && res.x >= 1 && res.y >= 1) ? {
      units: units,
      x: Math.min(65535, Math.round(res.x)),
      y: Math.min(65535, Math.round(res.y))
    } : null;

    return { bytes: bytes, density: density };
  }

  function readMeta(file) {
    return blobBytes(file.slice(0, META_SCAN)).then(function (bytes) {
      var meta = { density: null, app1: null };

      var jfif = findJfifApp0(bytes);
      if (jfif >= 0) {
        var units = bytes[jfif + 11];
        var x = (bytes[jfif + 12] << 8) | bytes[jfif + 13];
        var y = (bytes[jfif + 14] << 8) | bytes[jfif + 15];
        if (units && x && y) meta.density = { units: units, x: x, y: y };
      }

      var app1 = findExifApp1(bytes);
      if (app1 >= 0) {
        var len = ((bytes[app1 + 2] << 8) | bytes[app1 + 3]) + 2;
        var exif = normalizeExif(bytes.slice(app1, app1 + len));
        meta.app1 = exif.bytes;
        if (!meta.density) meta.density = exif.density;
      }
      return meta;
    }).catch(function () { return { density: null, app1: null }; });
  }

  // Splices the preserved APP1 in behind the SOI and rewrites the five density
  // bytes of the APP0 header the encoder wrote.
  function restoreHeaders(blob, meta) {
    return blobBytes(blob).then(function (bytes) {
      var out = bytes;
      if (meta.app1 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
        out = concat([bytes.subarray(0, 2), meta.app1, bytes.subarray(2)]);
      }

      var at = findJfifApp0(out);
      if (at >= 0) {
        var d = meta.density || DEFAULT_DENSITY;
        out[at + 11] = d.units;
        out[at + 12] = (d.x >> 8) & 0xFF;
        out[at + 13] = d.x & 0xFF;
        out[at + 14] = (d.y >> 8) & 0xFF;
        out[at + 15] = d.y & 0xFF;
      } else if (out === bytes) {
        return blob;
      }
      return new Blob([out], { type: MIME.jpeg });
    }).catch(function () { return blob; });
  }

  function clamp255(v) {
    v = Math.round(v);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function histogram(data, pixels) {
    var buckets = new Map();
    var transparent = false;
    for (var p = 0, i = 0; p < pixels; p++, i += 4) {
      var a = data[i + 3];
      if (a === 0) { transparent = true; continue; }
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var key = ((r >> 3) << 14) | ((g >> 3) << 9) | ((b >> 3) << 4) | (a >> 4);
      var e = buckets.get(key);
      if (e) {
        e.count++; e.rs += r; e.gs += g; e.bs += b; e.as += a;
      } else {
        buckets.set(key, { count: 1, rs: r, gs: g, bs: b, as: a });
      }
    }
    var entries = [];
    buckets.forEach(function (e) {
      entries.push({
        r: e.rs / e.count, g: e.gs / e.count,
        b: e.bs / e.count, a: e.as / e.count,
        count: e.count
      });
    });
    return { entries: entries, transparent: transparent };
  }

  var CHANNELS = ['r', 'g', 'b', 'a'];

  function makeBox(list) {
    var lo = [255, 255, 255, 255], hi = [0, 0, 0, 0], count = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      count += c.count;
      for (var k = 0; k < 4; k++) {
        var v = c[CHANNELS[k]];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }

    var weight = [2, 4, 1, 3], best = -1, ch = 0;
    for (var k2 = 0; k2 < 4; k2++) {
      var span = (hi[k2] - lo[k2]) * weight[k2];
      if (span > best) { best = span; ch = k2; }
    }
    return { list: list, channel: CHANNELS[ch], score: best * Math.log(count + 1), count: count };
  }

  function medianCut(entries, maxColors) {
    var boxes = [makeBox(entries)];
    while (boxes.length < maxColors) {
      var target = -1, best = 0;
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].list.length < 2) continue;
        if (boxes[i].score > best) { best = boxes[i].score; target = i; }
      }
      if (target < 0) break;

      var box = boxes[target];
      var ch = box.channel;
      var list = box.list.slice().sort(function (x, y) { return x[ch] - y[ch]; });

      var half = box.count / 2, acc = 0, cut = 0;
      for (var j = 0; j < list.length - 1; j++) {
        acc += list[j].count;
        if (acc >= half) { cut = j + 1; break; }
      }
      if (cut <= 0 || cut >= list.length) cut = list.length >> 1;

      boxes.splice(target, 1, makeBox(list.slice(0, cut)), makeBox(list.slice(cut)));
    }

    return boxes.map(function (box) {
      var rs = 0, gs = 0, bs = 0, as = 0, n = 0;
      for (var i = 0; i < box.list.length; i++) {
        var c = box.list[i];
        rs += c.r * c.count; gs += c.g * c.count;
        bs += c.b * c.count; as += c.a * c.count; n += c.count;
      }
      return [clamp255(rs / n), clamp255(gs / n), clamp255(bs / n), clamp255(as / n)];
    });
  }

  function buildPalette(data, pixels, maxColors) {
    var hist = histogram(data, pixels);
    var reserve = hist.transparent ? 1 : 0;
    var palette;

    if (hist.entries.length === 0) {
      palette = [];
    } else if (hist.entries.length <= maxColors - reserve) {
      palette = hist.entries.map(function (e) {
        return [clamp255(e.r), clamp255(e.g), clamp255(e.b), clamp255(e.a)];
      });
    } else {
      palette = medianCut(hist.entries, Math.max(1, maxColors - reserve));
    }

    if (hist.transparent) palette.unshift([0, 0, 0, 0]);
    if (palette.length === 0) palette.push([0, 0, 0, 0]);

    palette.sort(function (x, y) { return x[3] - y[3]; });
    return { palette: palette, hasTransparent: hist.transparent };
  }

  function makeMatcher(palette) {
    var cache = new Int16Array(1 << 18).fill(-1);

    function scan(r, g, b, a) {
      var best = 0, bestD = Infinity;
      for (var i = 0; i < palette.length; i++) {
        var p = palette[i];
        var da = a - p[3];
        var d = da * da * 3;
        if (d >= bestD) continue;
        var dr = r - p[0], dg = g - p[1], db = b - p[2];
        d += dr * dr * 2 + dg * dg * 4 + db * db;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    return function (r, g, b, a) {
      var key = ((r >> 3) << 13) | ((g >> 3) << 8) | ((b >> 3) << 3) | (a >> 5);
      var hit = cache[key];
      if (hit >= 0) return hit;
      var idx = scan(r, g, b, a);
      cache[key] = idx;
      return idx;
    };
  }

  function mapPixels(data, width, height, palette, transparentIndex, dither) {
    var pixels = width * height;
    var indices = new Uint8Array(pixels);
    var match = makeMatcher(palette);

    if (!dither) {
      for (var p = 0, i = 0; p < pixels; p++, i += 4) {
        var a = data[i + 3];
        indices[p] = a === 0 ? transparentIndex : match(data[i], data[i + 1], data[i + 2], a);
      }
      return indices;
    }

    var rowLen = (width + 2) * 3;
    var errCur = new Float32Array(rowLen);
    var errNext = new Float32Array(rowLen);

    for (var y = 0; y < height; y++) {
      var reverse = (y & 1) === 1;
      var dir = reverse ? -1 : 1;

      for (var k = 0; k < width; k++) {
        var x = reverse ? width - 1 - k : k;
        var pi = y * width + x;
        var di = pi * 4;
        var av = data[di + 3];
        if (av === 0) { indices[pi] = transparentIndex; continue; }

        var e = (x + 1) * 3; // +1 for the padding column
        var r = clamp255(data[di] + errCur[e]);
        var g = clamp255(data[di + 1] + errCur[e + 1]);
        var b = clamp255(data[di + 2] + errCur[e + 2]);

        var idx = match(r, g, b, av);
        indices[pi] = idx;

        var pe = palette[idx];
        var er = r - pe[0], eg = g - pe[1], eb = b - pe[2];

        var ahead = (x + dir + 1) * 3;
        var behind = (x - dir + 1) * 3;
        var below = (x + 1) * 3;

        errCur[ahead] += er * 0.4375;
        errCur[ahead + 1] += eg * 0.4375;
        errCur[ahead + 2] += eb * 0.4375;

        errNext[behind] += er * 0.1875;
        errNext[behind + 1] += eg * 0.1875;
        errNext[behind + 2] += eb * 0.1875;

        errNext[below] += er * 0.3125;
        errNext[below + 1] += eg * 0.3125;
        errNext[below + 2] += eb * 0.3125;

        errNext[ahead] += er * 0.0625;
        errNext[ahead + 1] += eg * 0.0625;
        errNext[ahead + 2] += eb * 0.0625;
      }

      var swap = errCur;
      errCur = errNext;
      errNext = swap;
      errNext.fill(0);
    }
    return indices;
  }

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    var out = new Uint8Array(data.length + 12);
    var view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
    return out;
  }

  function concat(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    for (i = 0, total = 0; i < parts.length; i++) {
      out.set(parts[i], total);
      total += parts[i].length;
    }
    return out;
  }

  function deflate(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function buildPNG8(width, height, palette, indices) {
    var depth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
    var perByte = 8 / depth;
    var rowBytes = Math.ceil(width / perByte);
    var raw = new Uint8Array((rowBytes + 1) * height);

    for (var y = 0, o = 0; y < height; y++) {
      raw[o++] = 0;
      if (depth === 8) {
        raw.set(indices.subarray(y * width, (y + 1) * width), o);
      } else {
        for (var x = 0; x < width; x++) {
          var shift = 8 - depth - (x % perByte) * depth;
          raw[o + ((x / perByte) | 0)] |= indices[y * width + x] << shift;
        }
      }
      o += rowBytes;
    }

    return deflate(raw).then(function (idat) {
      var ihdr = new Uint8Array(13);
      var view = new DataView(ihdr.buffer);
      view.setUint32(0, width);
      view.setUint32(4, height);
      ihdr[8] = depth;
      ihdr[9] = 3;
      ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

      var plte = new Uint8Array(palette.length * 3);
      var trnsLen = 0;
      for (var i = 0; i < palette.length; i++) {
        plte[i * 3] = palette[i][0];
        plte[i * 3 + 1] = palette[i][1];
        plte[i * 3 + 2] = palette[i][2];
        if (palette[i][3] < 255) trnsLen = i + 1;
      }

      var parts = [new Uint8Array(PNG_SIG), chunk('IHDR', ihdr), chunk('PLTE', plte)];
      if (trnsLen) {
        var trns = new Uint8Array(trnsLen);
        for (var t = 0; t < trnsLen; t++) trns[t] = palette[t][3];
        parts.push(chunk('tRNS', trns));
      }
      parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
      return new Blob([concat(parts)], { type: MIME.png });
    });
  }

  function encodePNG(canvas, ctx, quality, dither) {
    if (!canDeflate) return toBlob(canvas, MIME.png);
    var maxColors = Math.max(2, Math.min(256, Math.round((quality / 100) * 254) + 2));
    var image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var built = buildPalette(image.data, canvas.width * canvas.height, maxColors);
    var indices = mapPixels(
      image.data, canvas.width, canvas.height, built.palette, 0, dither
    );
    return buildPNG8(canvas.width, canvas.height, built.palette, indices);
  }

  function extensionOf(name) {
    var dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function resolveFormat(file, preference) {
    if (preference === 'webp') return supportsWebP() ? 'webp' : 'jpeg';
    if (preference === 'jpeg') return 'jpeg';
    if (preference === 'png') return 'png';

    var type = (file.type || '').toLowerCase() || extensionOf(file.name);
    if (type.indexOf('png') >= 0) return 'png';
    if (type.indexOf('webp') >= 0) return supportsWebP() ? 'webp' : 'jpeg';
    return 'jpeg';
  }

  var EXT_FORMATS = {
    jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg',
    png: 'png', webp: 'webp'
  };

  function renameTo(name, format) {
    var dot = name.lastIndexOf('.');
    var ext = dot > 0 ? name.slice(dot + 1) : '';
    // Servers often look the file up by the exact stored path, so an extension
    // that already describes the output format is left alone - case included.
    if (ext && EXT_FORMATS[ext.toLowerCase()] === format) return name;
    var base = dot > 0 ? name.slice(0, dot) : name;
    return base + '.' + (format === 'jpeg' ? 'jpg' : format);
  }

  function isJpegFile(file) {
    var type = (file.type || '').toLowerCase();
    return type.indexOf('jpeg') >= 0 || /\.jpe?g$/i.test(file.name || '');
  }

  function jpegExifSegment(buffer) {
    var view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;
    var off = 2;
    while (off + 4 <= view.byteLength) {
      if (view.getUint8(off) !== 0xFF) { off++; continue; }
      var marker = view.getUint8(off + 1);
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { off += 2; continue; }
      if (marker === 0xDA) break;
      var len = view.getUint16(off + 2);
      if (len < 2) break;
      if (marker === 0xE1 && off + 10 <= view.byteLength) {
        var sig = '';
        for (var i = 0; i < 4; i++) sig += String.fromCharCode(view.getUint8(off + 4 + i));
        if (sig === 'Exif') return new Uint8Array(buffer.slice(off, off + 2 + len));
      }
      off += 2 + len;
    }
    return null;
  }

  // The rotation is already baked into the pixels, so a surviving Orientation
  // tag would rotate the image a second time. Force it back to 1.
  function neutraliseOrientation(segment) {
    var view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
    var tiff = 10;
    if (tiff + 8 > segment.length) return;
    var mark = view.getUint16(tiff);
    if (mark !== 0x4949 && mark !== 0x4D4D) return;
    var little = mark === 0x4949;
    if (view.getUint16(tiff + 2, little) !== 42) return;

    var ifd = tiff + view.getUint32(tiff + 4, little);
    if (ifd + 2 > segment.length) return;
    var count = view.getUint16(ifd, little);
    for (var i = 0; i < count; i++) {
      var e = ifd + 2 + i * 12;
      if (e + 12 > segment.length) break;
      if (view.getUint16(e, little) === 0x0112) {
        view.setUint16(e + 8, 1, little);
        return;
      }
    }
  }

  function injectExif(jpeg, segment) {
    if (jpeg.length < 2 || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return null;
    var out = new Uint8Array(jpeg.length + segment.length);
    out.set(jpeg.subarray(0, 2), 0);
    out.set(segment, 2);
    out.set(jpeg.subarray(2), 2 + segment.length);
    return out;
  }

  // Removes EXIF and XMP while leaving everything that affects how the image
  // renders - the ICC colour profile in APP2 especially - exactly where it is.
  function stripJpegMetadata(buffer) {
    var view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;

    var src = new Uint8Array(buffer);
    var keep = [src.subarray(0, 2)];
    var off = 2, removed = false, reachedScan = false;

    while (off + 4 <= view.byteLength) {
      if (view.getUint8(off) !== 0xFF) { off++; continue; }
      var marker = view.getUint8(off + 1);

      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
        keep.push(src.subarray(off, off + 2));
        off += 2;
        continue;
      }
      if (marker === 0xDA) {           // start of scan: the rest is pixel data
        keep.push(src.subarray(off));
        reachedScan = true;
        break;
      }

      var len = view.getUint16(off + 2);
      if (len < 2 || off + 2 + len > view.byteLength) return null;

      var drop = false;
      if (marker === 0xE1) {
        var sig = '';
        for (var i = 0; i < 6 && off + 4 + i < view.byteLength; i++) {
          sig += String.fromCharCode(view.getUint8(off + 4 + i));
        }
        if (sig.indexOf('Exif') === 0 || sig.indexOf('http:/') === 0) drop = true;
      }

      if (drop) removed = true;
      else keep.push(src.subarray(off, off + 2 + len));
      off += 2 + len;
    }

    if (!removed || !reachedScan) return null;
    return concat(keep);
  }

  // Used when re-encoding grew the file and the original is handed back. Even
  // then "keep EXIF: off" has to be honoured, or unchecking the box would do
  // nothing on exactly the files that skip compression.
  function fallbackToOriginal(file, keepExif) {
    if (keepExif || !isJpegFile(file)) {
      return Promise.resolve({ blob: file, kept: true });
    }
    return file.arrayBuffer().then(function (buffer) {
      var stripped = stripJpegMetadata(buffer);
      if (!stripped || stripped.length >= file.size) {
        return { blob: file, kept: true };
      }
      return { blob: new Blob([stripped], { type: MIME.jpeg }), kept: false };
    }).catch(function () {
      return { blob: file, kept: true };
    });
  }

  function carryExif(file, blob, format, wanted) {
    if (!wanted || format !== 'jpeg' || !isJpegFile(file)) {
      return Promise.resolve({ blob: blob, kept: false });
    }
    return Promise.all([file.arrayBuffer(), blob.arrayBuffer()]).then(function (parts) {
      var segment = jpegExifSegment(parts[0]);
      if (!segment) return { blob: blob, kept: false };
      neutraliseOrientation(segment);
      var merged = injectExif(new Uint8Array(parts[1]), segment);
      return merged
        ? { blob: new Blob([merged], { type: MIME.jpeg }), kept: true }
        : { blob: blob, kept: false };
    }).catch(function () {
      return { blob: blob, kept: false };
    });
  }

  function compress(file, options) {
    var opts = options || {};
    var quality = typeof opts.quality === 'number' ? opts.quality : 60;
    var dither = !!opts.dither;

    return loadSource(file).then(function (src) {
      var canvas = null;
      try {
        var width = src.width, height = src.height;
        if (!width || !height) throw new Error('Image reported zero dimensions');

        if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE ||
            width * height > MAX_CANVAS_AREA) {
          throw new Error(
            'Image is too large for this browser to process (' +
            width + ' x ' + height + ')'
          );
        }

        var format = resolveFormat(file, opts.format || 'auto');
        var opaque = format === 'jpeg';

        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d', { willReadFrequently: format === 'png' });
        if (!ctx) throw new Error('Could not get a 2D drawing context');

        if (opaque) {
          ctx.fillStyle = opts.background || '#ffffff';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(src.source, 0, 0);

        var originalThumb = thumbFromSource(src.source, width, height);

        var encoded = format === 'png'
          ? encodePNG(canvas, ctx, quality, dither)
          : toBlob(canvas, MIME[format], quality / 100);

        if (format === 'jpeg') {
          encoded = Promise.all([encoded, readMeta(file)]).then(function (r) {
            return restoreHeaders(r[0], r[1]);
          });
        }

        return encoded.then(function (blob) {

          releaseCanvas(canvas);
          canvas = null;

          // EXIF is transplanted before the size comparison, so the decision to
          // keep the original is made against what would actually be saved.
          return carryExif(file, blob, format, opts.keepExif).then(function (carried) {
            var grew = carried.blob.size >= file.size;

            var settled = grew
              ? fallbackToOriginal(file, opts.keepExif)
              : Promise.resolve({ blob: carried.blob, kept: carried.kept });

            return settled.then(function (chosen) {
              var finalBlob = chosen.blob;
              var finalFormat = grew ? resolveFormat(file, 'auto') : format;

              return Promise.all([
                originalThumb,
                thumbFromBlob(finalBlob, width, height)
              ]).then(function (thumbs) {
                return {
                  blob: finalBlob,
                  url: URL.createObjectURL(finalBlob),
                  originalThumbUrl: thumbs[0] ? URL.createObjectURL(thumbs[0]) : null,
                  thumbUrl: thumbs[1] ? URL.createObjectURL(thumbs[1]) : null,
                  name: grew ? file.name : renameTo(file.name, format),
                  format: finalFormat,
                  width: width,
                  height: height,
                  size: finalBlob.size,
                  originalSize: file.size,
                  skipped: grew,
                  keptExif: chosen.kept
                };
              });
            });
          });
        }, function (err) {
          releaseCanvas(canvas);
          canvas = null;
          throw err;
        });
      } catch (err) {
        releaseCanvas(canvas);
        throw err;
      } finally {
        src.release();
      }
    });
  }

  /* Metadata ---------------------------------------------------------- *
   * Reads what the file itself carries: EXIF from JPEG and WebP, text
   * chunks and header fields from PNG. Everything is parsed by hand from
   * the bytes, so no library is needed and nothing leaves the browser.   */

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  var TIFF_TAGS = {
    0x010D: 'DocumentName', 0x010E: 'ImageDescription', 0x010F: 'Make',
    0x0110: 'Model', 0x0112: 'Orientation', 0x011A: 'XResolution',
    0x011B: 'YResolution', 0x0128: 'ResolutionUnit', 0x0131: 'Software',
    0x0132: 'DateTime', 0x013B: 'Artist', 0x8298: 'Copyright',
    0x829A: 'ExposureTime', 0x829D: 'FNumber', 0x8822: 'ExposureProgram',
    0x8827: 'ISO', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
    0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue',
    0x9204: 'ExposureBiasValue', 0x9205: 'MaxApertureValue',
    0x9207: 'MeteringMode', 0x9208: 'LightSource', 0x9209: 'Flash',
    0x920A: 'FocalLength', 0xA002: 'PixelXDimension', 0xA003: 'PixelYDimension',
    0xA402: 'ExposureMode', 0xA403: 'WhiteBalance', 0xA404: 'DigitalZoomRatio',
    0xA405: 'FocalLengthIn35mmFilm', 0xA406: 'SceneCaptureType',
    0xA408: 'Contrast', 0xA409: 'Saturation', 0xA40A: 'Sharpness',
    0xA430: 'CameraOwnerName', 0xA431: 'BodySerialNumber',
    0xA433: 'LensMake', 0xA434: 'LensModel', 0xA435: 'LensSerialNumber'
  };

  var GPS_TAGS = {
    0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude',
    0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude',
    0x0005: 'GPSAltitudeRef', 0x0006: 'GPSAltitude',
    0x0007: 'GPSTimeStamp', 0x000B: 'GPSDOP', 0x0012: 'GPSMapDatum',
    0x001D: 'GPSDateStamp'
  };

  var ORIENTATION = {
    1: 'Normal', 2: 'Mirrored horizontally', 3: 'Rotated 180 degrees',
    4: 'Mirrored vertically', 5: 'Mirrored and rotated 270 degrees',
    6: 'Rotated 90 degrees clockwise', 7: 'Mirrored and rotated 90 degrees',
    8: 'Rotated 270 degrees clockwise'
  };
  var EXPOSURE_PROGRAM = {
    0: 'Not defined', 1: 'Manual', 2: 'Program', 3: 'Aperture priority',
    4: 'Shutter priority', 5: 'Creative', 6: 'Action', 7: 'Portrait', 8: 'Landscape'
  };
  var METERING = {
    0: 'Unknown', 1: 'Average', 2: 'Centre weighted', 3: 'Spot',
    4: 'Multi spot', 5: 'Pattern', 6: 'Partial'
  };
  var WHITE_BALANCE = { 0: 'Auto', 1: 'Manual' };
  var EXPOSURE_MODE = { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' };
  var SCENE_TYPE = { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' };
  var PNG_COLOR = {
    0: 'Greyscale', 2: 'Truecolour', 3: 'Indexed', 4: 'Greyscale with alpha',
    6: 'Truecolour with alpha'
  };

  function readValue(view, tiff, at, type, count, little) {
    var size = TYPE_SIZE[type];
    if (!size) return null;
    var total = size * count;
    var p = total > 4 ? tiff + view.getUint32(at, little) : at;
    if (p < 0 || p + total > view.byteLength) return null;

    if (type === 2) {
      var s = '';
      for (var i = 0; i < count; i++) {
        var c = view.getUint8(p + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.replace(/\s+$/, '');
    }

    var out = [];
    for (var j = 0; j < count; j++) {
      var o = p + j * size;
      if (type === 1 || type === 7) out.push(view.getUint8(o));
      else if (type === 6) out.push(view.getInt8(o));
      else if (type === 3) out.push(view.getUint16(o, little));
      else if (type === 8) out.push(view.getInt16(o, little));
      else if (type === 4) out.push(view.getUint32(o, little));
      else if (type === 9) out.push(view.getInt32(o, little));
      else if (type === 11) out.push(view.getFloat32(o, little));
      else if (type === 12) out.push(view.getFloat64(o, little));
      else if (type === 5 || type === 10) {
        var n = type === 5 ? view.getUint32(o, little) : view.getInt32(o, little);
        var d = type === 5 ? view.getUint32(o + 4, little) : view.getInt32(o + 4, little);
        out.push(d ? n / d : 0);
      }
    }
    return count === 1 ? out[0] : out;
  }

  function readIFD(view, tiff, offset, little, names, into) {
    if (offset < 0 || offset + 2 > view.byteLength) return {};
    var count = view.getUint16(offset, little);
    var pointers = {};
    for (var i = 0; i < count; i++) {
      var e = offset + 2 + i * 12;
      if (e + 12 > view.byteLength) break;
      var tag = view.getUint16(e, little);
      var type = view.getUint16(e + 2, little);
      var num = view.getUint32(e + 4, little);
      if (num > 65535) continue;
      var value = readValue(view, tiff, e + 8, type, num, little);
      if (tag === 0x8769 || tag === 0x8825) { pointers[tag] = value; continue; }
      var name = names[tag];
      if (name && value !== null && value !== '') into[name] = value;
    }
    return pointers;
  }

  function parseTiff(view, tiff, tags, gps) {
    if (tiff + 8 > view.byteLength) return false;
    var mark = view.getUint16(tiff);
    if (mark !== 0x4949 && mark !== 0x4D4D) return false;
    var little = mark === 0x4949;
    if (view.getUint16(tiff + 2, little) !== 42) return false;

    var first = view.getUint32(tiff + 4, little);
    var pointers = readIFD(view, tiff, tiff + first, little, TIFF_TAGS, tags);
    if (pointers[0x8769]) {
      readIFD(view, tiff, tiff + pointers[0x8769], little, TIFF_TAGS, tags);
    }
    if (pointers[0x8825]) {
      readIFD(view, tiff, tiff + pointers[0x8825], little, GPS_TAGS, gps);
    }
    return true;
  }

  function findJpegExif(view) {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return -1;
    var off = 2;
    while (off + 4 <= view.byteLength) {
      if (view.getUint8(off) !== 0xFF) { off++; continue; }
      var marker = view.getUint8(off + 1);
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { off += 2; continue; }
      if (marker === 0xDA) break;
      var len = view.getUint16(off + 2);
      if (len < 2) break;
      if (marker === 0xE1 && off + 10 <= view.byteLength) {
        var sig = '';
        for (var i = 0; i < 4; i++) sig += String.fromCharCode(view.getUint8(off + 4 + i));
        if (sig === 'Exif') return off + 10;
      }
      off += 2 + len;
    }
    return -1;
  }

  function findWebpExif(view) {
    if (view.byteLength < 16) return -1;
    if (view.getUint32(0) !== 0x52494646) return -1;         // 'RIFF'
    if (view.getUint32(8) !== 0x57454250) return -1;         // 'WEBP'
    var off = 12;
    while (off + 8 <= view.byteLength) {
      var id = view.getUint32(off);
      var size = view.getUint32(off + 4, true);
      if (id === 0x45584946) return off + 8;                 // 'EXIF'
      off += 8 + size + (size & 1);
    }
    return -1;
  }

  function parsePng(view, info) {
    if (view.byteLength < 24) return;
    var off = 8;
    while (off + 8 <= view.byteLength) {
      var len = view.getUint32(off);
      var type = '';
      for (var i = 0; i < 4; i++) type += String.fromCharCode(view.getUint8(off + 4 + i));
      var data = off + 8;
      if (data + len > view.byteLength) break;

      if (type === 'IHDR') {
        info.bitDepth = view.getUint8(data + 8);
        info.colorType = view.getUint8(data + 9);
        info.interlaced = view.getUint8(data + 12) === 1;
      } else if (type === 'tEXt' || type === 'iTXt') {
        var text = '';
        for (var j = 0; j < len && j < 4096; j++) {
          text += String.fromCharCode(view.getUint8(data + j));
        }
        var nul = text.indexOf('\0');
        if (nul > 0) {
          var key = text.slice(0, nul);
          var val = text.slice(nul + 1).replace(/^[\0-\x08]+/, '').replace(/\0/g, ' ').trim();
          if (val) info.text[key] = val;
        }
      } else if (type === 'pHYs') {
        var px = view.getUint32(data), py = view.getUint32(data + 4);
        if (view.getUint8(data + 8) === 1) {
          info.density = Math.round(px * 0.0254) + ' x ' + Math.round(py * 0.0254) + ' DPI';
        }
      } else if (type === 'IEND') break;

      off = data + len + 4;
    }
  }

  function shutter(seconds) {
    if (!seconds) return null;
    if (seconds >= 1) return (Math.round(seconds * 10) / 10) + ' s';
    return '1/' + Math.round(1 / seconds) + ' s';
  }

  function gpsDecimal(parts, ref) {
    if (!parts || parts.length < 3) return null;
    var deg = parts[0] + parts[1] / 60 + parts[2] / 3600;
    if (ref === 'S' || ref === 'W') deg = -deg;
    return Math.round(deg * 1000000) / 1000000;
  }

  function pushRow(rows, label, value) {
    if (value === null || value === undefined || value === '') return;
    rows.push([label, String(value)]);
  }

  function buildGroups(tags, gps, png) {
    var groups = [];

    var camera = [];
    pushRow(camera, 'Make', tags.Make);
    pushRow(camera, 'Model', tags.Model);
    pushRow(camera, 'Lens', tags.LensModel || tags.LensMake);
    pushRow(camera, 'Owner', tags.CameraOwnerName);
    pushRow(camera, 'Body serial', tags.BodySerialNumber);
    pushRow(camera, 'Software', tags.Software);
    if (camera.length) groups.push({ title: 'Camera', rows: camera });

    var shot = [];
    pushRow(shot, 'Taken', tags.DateTimeOriginal);
    pushRow(shot, 'Digitised', tags.DateTimeDigitized);
    pushRow(shot, 'File modified (EXIF)', tags.DateTime);
    pushRow(shot, 'Exposure', shutter(tags.ExposureTime));
    pushRow(shot, 'Aperture', tags.FNumber ? 'f/' + tags.FNumber : null);
    pushRow(shot, 'ISO', tags.ISO);
    pushRow(shot, 'Focal length', tags.FocalLength ? tags.FocalLength + ' mm' : null);
    pushRow(shot, 'Focal length (35mm)',
      tags.FocalLengthIn35mmFilm ? tags.FocalLengthIn35mmFilm + ' mm' : null);
    pushRow(shot, 'Exposure bias',
      typeof tags.ExposureBiasValue === 'number'
        ? (Math.round(tags.ExposureBiasValue * 100) / 100) + ' EV' : null);
    pushRow(shot, 'Program', EXPOSURE_PROGRAM[tags.ExposureProgram]);
    pushRow(shot, 'Exposure mode', EXPOSURE_MODE[tags.ExposureMode]);
    pushRow(shot, 'Metering', METERING[tags.MeteringMode]);
    pushRow(shot, 'White balance', WHITE_BALANCE[tags.WhiteBalance]);
    pushRow(shot, 'Flash', typeof tags.Flash === 'number'
      ? ((tags.Flash & 1) ? 'Fired' : 'Did not fire') : null);
    pushRow(shot, 'Scene', SCENE_TYPE[tags.SceneCaptureType]);
    pushRow(shot, 'Orientation', ORIENTATION[tags.Orientation]);
    if (shot.length) groups.push({ title: 'Capture', rows: shot });

    var place = [];
    var lat = gpsDecimal(tags.GPSLatitude || gps.GPSLatitude, gps.GPSLatitudeRef);
    var lon = gpsDecimal(tags.GPSLongitude || gps.GPSLongitude, gps.GPSLongitudeRef);
    if (lat !== null && lon !== null) {
      pushRow(place, 'Coordinates', lat + ', ' + lon);
      pushRow(place, 'Map', 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon);
    }
    if (typeof gps.GPSAltitude === 'number') {
      pushRow(place, 'Altitude', Math.round(gps.GPSAltitude) + ' m' +
        (gps.GPSAltitudeRef === 1 ? ' below sea level' : ''));
    }
    pushRow(place, 'GPS date', gps.GPSDateStamp);
    if (place.length) groups.push({ title: 'Location', rows: place });

    var desc = [];
    pushRow(desc, 'Description', tags.ImageDescription);
    pushRow(desc, 'Artist', tags.Artist);
    pushRow(desc, 'Copyright', tags.Copyright);
    if (tags.XResolution) {
      pushRow(desc, 'Resolution', Math.round(tags.XResolution) + ' x ' +
        Math.round(tags.YResolution || tags.XResolution) +
        (tags.ResolutionUnit === 3 ? ' per cm' : ' DPI'));
    }
    if (desc.length) groups.push({ title: 'Description', rows: desc });

    if (png) {
      var pngRows = [];
      pushRow(pngRows, 'Bit depth', png.bitDepth ? png.bitDepth + ' bits per channel' : null);
      pushRow(pngRows, 'Colour type', PNG_COLOR[png.colorType]);
      pushRow(pngRows, 'Interlaced', png.interlaced === undefined ? null
        : (png.interlaced ? 'Yes' : 'No'));
      pushRow(pngRows, 'Density', png.density);
      Object.keys(png.text || {}).forEach(function (key) {
        pushRow(pngRows, key, png.text[key]);
      });
      if (pngRows.length) groups.push({ title: 'PNG header', rows: pngRows });
    }

    return groups;
  }

  function readMetadata(file) {
    return file.arrayBuffer().then(function (buffer) {
      var view = new DataView(buffer);
      var tags = {}, gps = {}, png = null, found = false;
      var type = (file.type || '').toLowerCase();
      var name = (file.name || '').toLowerCase();

      if (type.indexOf('png') >= 0 || /\.png$/.test(name)) {
        png = { text: {} };
        parsePng(view, png);
        found = Object.keys(png.text).length > 0;
      } else if (type.indexOf('webp') >= 0 || /\.webp$/.test(name)) {
        var w = findWebpExif(view);
        if (w >= 0) found = parseTiff(view, w, tags, gps);
      } else {
        var j = findJpegExif(view);
        if (j >= 0) found = parseTiff(view, j, tags, gps);
      }

      return {
        hasMetadata: found || Object.keys(tags).length > 0,
        tags: tags,
        gps: gps,
        groups: buildGroups(tags, gps, png)
      };
    }).catch(function () {
      return { hasMetadata: false, tags: {}, gps: {}, groups: [] };
    });
  }

  /* ZIP ---------------------------------------------------------------- *
   * Entries are stored, not deflated. JPEG, PNG and WebP payloads are already
   * compressed, so deflating them again costs time and saves nothing. That
   * keeps the writer small enough to need no library.                      */

  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  }

  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  function uniqueNames(entries) {
    var seen = {};
    return entries.map(function (entry) {
      var name = entry.name || 'image';
      if (!seen[name]) { seen[name] = 1; return name; }
      var dot = name.lastIndexOf('.');
      var base = dot > 0 ? name.slice(0, dot) : name;
      var ext = dot > 0 ? name.slice(dot) : '';
      var next = base + ' (' + (seen[name]++) + ')' + ext;
      seen[next] = 1;
      return next;
    });
  }

  function zip(entries, when) {
    if (!entries || !entries.length) return Promise.reject(new Error('Nothing to zip'));
    var names = uniqueNames(entries);
    var stamp = when || new Date();
    var time = dosTime(stamp), date = dosDate(stamp);
    var encoder = new TextEncoder();

    return Promise.all(entries.map(function (e) { return e.blob.arrayBuffer(); }))
      .then(function (buffers) {
        var parts = [], central = [], offset = 0;

        buffers.forEach(function (buffer, i) {
          var data = new Uint8Array(buffer);
          var nameBytes = encoder.encode(names[i]);
          var crc = crc32(data);

          var local = new Uint8Array(30 + nameBytes.length);
          var lv = new DataView(local.buffer);
          lv.setUint32(0, 0x04034b50, true);
          lv.setUint16(4, 20, true);       // version needed
          lv.setUint16(6, 0x0800, true);   // names are UTF-8
          lv.setUint16(8, 0, true);        // stored
          lv.setUint16(10, time, true);
          lv.setUint16(12, date, true);
          lv.setUint32(14, crc, true);
          lv.setUint32(18, data.length, true);
          lv.setUint32(22, data.length, true);
          lv.setUint16(26, nameBytes.length, true);
          local.set(nameBytes, 30);

          var entry = new Uint8Array(46 + nameBytes.length);
          var cv = new DataView(entry.buffer);
          cv.setUint32(0, 0x02014b50, true);
          cv.setUint16(4, 20, true);       // version made by
          cv.setUint16(6, 20, true);       // version needed
          cv.setUint16(8, 0x0800, true);
          cv.setUint16(10, 0, true);
          cv.setUint16(12, time, true);
          cv.setUint16(14, date, true);
          cv.setUint32(16, crc, true);
          cv.setUint32(20, data.length, true);
          cv.setUint32(24, data.length, true);
          cv.setUint16(28, nameBytes.length, true);
          cv.setUint32(42, offset, true);  // where its local header sits
          entry.set(nameBytes, 46);

          parts.push(local, data);
          central.push(entry);
          offset += local.length + data.length;
        });

        var centralSize = central.reduce(function (sum, c) { return sum + c.length; }, 0);
        var end = new Uint8Array(22);
        var ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, entries.length, true);
        ev.setUint16(10, entries.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, offset, true);

        return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
      });
  }

  return {
    compress: compress,
    readMetadata: readMetadata,
    zip: zip,
    supportsWebP: supportsWebP,
    supportsPNG8: function () { return canDeflate; }
  };
})();

var jic = {
  compress: function (imageElement, qualityPercentage, fileType) {
    var mimeType = fileType === 'png' ? 'image/png' : 'image/jpeg';
    var canvas = document.createElement('canvas');
    canvas.width = imageElement.naturalWidth || imageElement.width;
    canvas.height = imageElement.naturalHeight || imageElement.height;
    if (!canvas.width || !canvas.height) {
      throw new Error('jic.compress: image is not decoded yet - wait for onload/decode()');
    }
    var context = canvas.getContext('2d');
    if (mimeType === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(imageElement, 0, 0);
    var out = new Image();
    out.src = canvas.toDataURL(mimeType, qualityPercentage / 100);
    return out;
  }
};
