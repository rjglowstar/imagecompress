
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
      return createImageBitmap(file).then(function (bitmap) {
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

  function renameTo(name, format) {
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    return base + '.' + (format === 'jpeg' ? 'jpg' : format);
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

        var encoded = format === 'png'
          ? encodePNG(canvas, ctx, quality, dither)
          : toBlob(canvas, MIME[format], quality / 100);

        return encoded.then(function (blob) {

          releaseCanvas(canvas);
          canvas = null;

          var grew = blob.size >= file.size;
          var finalBlob = grew ? file : blob;
          var finalFormat = grew ? resolveFormat(file, 'auto') : format;
          return {
            blob: finalBlob,
            url: URL.createObjectURL(finalBlob),
            name: grew ? file.name : renameTo(file.name, format),
            format: finalFormat,
            width: width,
            height: height,
            size: finalBlob.size,
            originalSize: file.size,
            skipped: grew
          };
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

  return {
    compress: compress,
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
