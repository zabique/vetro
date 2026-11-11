'use strict';
// Signs a Tizen package (.wgt or .tpk, a zip) in place, the way Tizen Studio does: author-signature.xml and
// signature1.xml (W3C "XML Digital Signatures for Widgets") are added at the top of the archive, older signature
// files are dropped, every other entry is copied as it is.
//
// Only Node's own modules: the archive is read entry by entry (never whole in memory), digests are SHA-512 and
// the signature is RSA-SHA512 over the canonical SignedInfo. The certificates arrive as PEM material that
// index.js got from the user's .p12 files with the TV's openssl. Plain ES5.

var fs = require('fs');
var zlib = require('zlib');
var crypto = require('crypto');

var DSIG = 'http://www.w3.org/2000/09/xmldsig#';
var SIGNATURE_FILE = /^(author-signature\.xml|signature[0-9]*\.xml)$/;
var COPY_BLOCK = 1024 * 1024;

function buffer(n) { return typeof Buffer.alloc === 'function' ? Buffer.alloc(n) : new Buffer(n).fill(0); }
function fromText(s) { return typeof Buffer.alloc === 'function' ? Buffer.from(s, 'utf8') : new Buffer(s, 'utf8'); }
function wrap76(s) { return s.replace(/(.{76})/g, '$1\n'); }
function sha512(data) { return crypto.createHash('sha512').update(data).digest('base64'); }
// A zip path as the URI of a Reference: percent-encoded, then safe inside a double-quoted attribute.
function uriOf(name) { return encodeURI(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

var CRC_TABLE = (function () {
    var t = [], n, k, c;
    for (n = 0; n < 256; n++) {
        c = n;
        for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── the signature document ──────────────────────────────────────────────────────────────────────────────
// The Object every Tizen signature carries. It is referenced as "#prop" through C14N 1.1, where the element
// stands on its own and so carries the namespace it inherits in the file.
function propObject(id, canonical) {
    var role = id === 'AuthorSignature' ? 'author' : 'distributor';
    return '<Object' + (canonical ? ' xmlns="' + DSIG + '"' : '') + ' Id="prop">' +
        '<SignatureProperties xmlns:dsp="http://www.w3.org/2009/xmldsig-properties">' +
        '<SignatureProperty Id="profile" Target="#' + id + '">' +
        '<dsp:Profile URI="http://www.w3.org/ns/widgets-digsig#profile"></dsp:Profile></SignatureProperty>' +
        '<SignatureProperty Id="role" Target="#' + id + '">' +
        '<dsp:Role URI="http://www.w3.org/ns/widgets-digsig#role-' + role + '"></dsp:Role></SignatureProperty>' +
        '<SignatureProperty Id="identifier" Target="#' + id + '">' +
        '<dsp:Identifier></dsp:Identifier></SignatureProperty></SignatureProperties></Object>';
}

function reference(uri, digest, transform) {
    return '<Reference URI="' + uri + '">\n' +
        (transform ? '<Transforms>\n<Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"></Transform>\n</Transforms>\n' : '') +
        '<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha512"></DigestMethod>\n' +
        '<DigestValue>' + wrap76(digest) + '</DigestValue>\n' +
        '</Reference>\n';
}

// id: AuthorSignature or DistributorSignature; refs: [{name, digest}] in archive order;
// cert: {chain: [base64 DER, leaf first], key: PEM private key}.
function signatureXml(id, refs, cert) {
    var body = '\n<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>\n' +
        '<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"></SignatureMethod>\n' +
        refs.map(function (r) { return reference(uriOf(r.name), r.digest, false); }).join('') +
        reference('#prop', sha512(fromText(propObject(id, true))), true) +
        '</SignedInfo>';
    // Exclusive C14N of SignedInfo as written here: the element only gains the namespace it uses.
    var value = crypto.createSign('RSA-SHA512').update('<SignedInfo xmlns="' + DSIG + '">' + body).sign(cert.key, 'base64');
    var keyInfo = '<KeyInfo>\n<X509Data>' + cert.chain.map(function (der) {
        return '\n<X509Certificate>\n' + wrap76(der) + '\n</X509Certificate>';
    }).join('') + '\n</X509Data>\n</KeyInfo>\n';
    return '<Signature xmlns="' + DSIG + '" Id="' + id + '">\n' +
        '<SignedInfo>' + body + '\n' +
        '<SignatureValue>\n' + wrap76(value) + '\n</SignatureValue>\n' +
        keyInfo + propObject(id, false) + '\n</Signature>\n';
}

// ── the archive ─────────────────────────────────────────────────────────────────────────────────────────
function readAt(fd, position, length) {
    var b = buffer(length), got = 0, n;
    while (got < length) {
        n = fs.readSync(fd, b, got, length - got, position + got);
        if (!n) throw new Error('The package is cut short');
        got += n;
    }
    return b;
}

// The central directory: [{name, raw (its name bytes), flags, method, time, date, crc, csize, usize, offset, ...}].
function readDirectory(fd, size) {
    if (size < 22) throw new Error('Not a zip archive');
    var tailLength = Math.min(size, 65557), tail = readAt(fd, size - tailLength, tailLength), at = -1;
    for (var i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
    if (at < 0) throw new Error('Not a zip archive');
    var count = tail.readUInt16LE(at + 10), dirSize = tail.readUInt32LE(at + 12), dirOffset = tail.readUInt32LE(at + 16);
    if (count === 0xFFFF || dirOffset === 0xFFFFFFFF || dirOffset + dirSize > size) throw new Error('Zip64 archives are not supported');
    var dir = readAt(fd, dirOffset, dirSize), p = 0, entries = [];
    for (var n = 0; n < count; n++) {
        if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip directory is damaged');
        var nameLength = dir.readUInt16LE(p + 28), extra = dir.readUInt16LE(p + 30), comment = dir.readUInt16LE(p + 32);
        var e = {
            made: dir.readUInt16LE(p + 4), need: dir.readUInt16LE(p + 6), flags: dir.readUInt16LE(p + 8), method: dir.readUInt16LE(p + 10),
            time: dir.readUInt16LE(p + 12), date: dir.readUInt16LE(p + 14), crc: dir.readUInt32LE(p + 16),
            csize: dir.readUInt32LE(p + 20), usize: dir.readUInt32LE(p + 24), internal: dir.readUInt16LE(p + 36),
            external: dir.readUInt32LE(p + 38), offset: dir.readUInt32LE(p + 42), raw: dir.slice(p + 46, p + 46 + nameLength)
        };
        e.name = e.raw.toString('utf8');
        if (e.flags & 1) throw new Error('Encrypted archives are not supported');
        if (e.csize === 0xFFFFFFFF || e.usize === 0xFFFFFFFF || e.offset === 0xFFFFFFFF) throw new Error('Zip64 archives are not supported');
        if (e.method !== 0 && e.method !== 8) throw new Error('Unsupported compression in ' + e.name);
        entries.push(e);
        p += 46 + nameLength + extra + comment;
    }
    return entries;
}

// Where an entry's bytes start: after its local header, whose name and extra lengths are its own.
function dataStart(fd, e) {
    var h = readAt(fd, e.offset, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('The zip is damaged at ' + e.name);
    return e.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

// The digest of one entry's content, without blocking the service while a big file inflates.
function digestOf(fd, e, done) {
    var raw;
    try { raw = readAt(fd, dataStart(fd, e), e.csize); } catch (x) { return done(x); }
    if (e.method === 0) return setImmediate(function () { done(null, sha512(raw)); });
    zlib.inflateRaw(raw, function (err, data) {
        if (err) return done(new Error('Could not read ' + e.name + ' from the package'));
        done(null, sha512(data));
    });
}

function dosTime(d) {
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

function localHeader(e) {
    var h = buffer(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(e.need, 4); h.writeUInt16LE(e.flags & ~8, 6); h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(e.time, 10); h.writeUInt16LE(e.date, 12); h.writeUInt32LE(e.crc, 14); h.writeUInt32LE(e.csize, 18);
    h.writeUInt32LE(e.usize, 22); h.writeUInt16LE(e.raw.length, 26); h.writeUInt16LE(0, 28);
    return Buffer.concat([h, e.raw]);
}
function directoryRecord(e, offset) {
    var h = buffer(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(e.made, 4); h.writeUInt16LE(e.need, 6); h.writeUInt16LE(e.flags & ~8, 8);
    h.writeUInt16LE(e.method, 10); h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14); h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.csize, 20); h.writeUInt32LE(e.usize, 24); h.writeUInt16LE(e.raw.length, 28);
    h.writeUInt16LE(e.internal, 36); h.writeUInt32LE(e.external, 38); h.writeUInt32LE(offset, 42);
    return Buffer.concat([h, e.raw]);
}

// A new entry made here (a signature file).
function newEntry(name, text, when) {
    var data = fromText(text), packed = zlib.deflateRawSync(data), t = dosTime(when);
    return { made: 20, need: 20, flags: 0x0800, method: 8, time: t.time, date: t.date, crc: crc32(data), csize: packed.length,
        usize: data.length, internal: 0, external: 0, raw: fromText(name), name: name, packed: packed };
}

// file: the package, rewritten in place. certs: {author: {chain, key}, distributor?: {chain, key}}.
// Resolves {files: entries signed, size: bytes of the signed package, distributor: true|false}.
function signPackage(file, certs, now) {
    return new Promise(function (resolve, reject) {
        var fd = null, out = null, temp = file + '.signing';
        function fail(e) {
            try { if (fd !== null) fs.closeSync(fd); } catch (x) { /* closing */ }
            try { if (out !== null) fs.closeSync(out); } catch (x) { /* closing */ }
            try { fs.unlinkSync(temp); } catch (x) { /* never made */ }
            reject(e);
        }
        try {
            if (!certs || !certs.author || !certs.author.key || !certs.author.chain || !certs.author.chain.length) throw new Error('No author certificate');
            fd = fs.openSync(file, 'r');
            var entries = readDirectory(fd, fs.fstatSync(fd).size).filter(function (e) { return !SIGNATURE_FILE.test(e.name); });
            var files = entries.filter(function (e) { return !/\/$/.test(e.name); });
            if (!files.length) throw new Error('The package holds no files');
        } catch (e) { return fail(e); }

        var index = 0;
        (function next() {
            if (index === files.length) return write();
            var e = files[index++];
            digestOf(fd, e, function (err, digest) {
                if (err) return fail(err);
                e.digest = digest;
                next();
            });
        })();

        function write() {
            try {
                var when = now || new Date();
                var refs = files.map(function (e) { return { name: e.name, digest: e.digest }; });
                var authorXml = signatureXml('AuthorSignature', refs, certs.author);
                var added = [newEntry('author-signature.xml', authorXml, when)];
                if (certs.distributor) {
                    var all = [{ name: 'author-signature.xml', digest: sha512(fromText(authorXml)) }].concat(refs);
                    added.push(newEntry('signature1.xml', signatureXml('DistributorSignature', all, certs.distributor), when));
                }
                out = fs.openSync(temp, 'w');
                var position = 0, records = [];
                added.forEach(function (e) {
                    records.push(directoryRecord(e, position));
                    var head = localHeader(e);
                    fs.writeSync(out, head, 0, head.length); fs.writeSync(out, e.packed, 0, e.packed.length);
                    position += head.length + e.packed.length;
                });
                var i = 0;
                (function copy() {
                    try {
                        if (i === entries.length) return finish(position, records, added.length + entries.length);
                        var e = entries[i++], from = dataStart(fd, e), left = e.csize, head = localHeader(e);
                        records.push(directoryRecord(e, position));
                        fs.writeSync(out, head, 0, head.length);
                        position += head.length + e.csize;
                        while (left > 0) {
                            var block = readAt(fd, from, Math.min(left, COPY_BLOCK));
                            fs.writeSync(out, block, 0, block.length);
                            from += block.length; left -= block.length;
                        }
                        setImmediate(copy);     // one entry per turn: the service keeps answering
                    } catch (e2) { fail(e2); }
                })();
            } catch (e) { fail(e); }
        }

        function finish(position, records, count) {
            try {
                var dir = Buffer.concat(records), end = buffer(22);
                if (count > 0xFFFE || position + dir.length > 0xFFFFFFFE) throw new Error('The package is too large to sign');
                end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
                end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(position, 16);
                fs.writeSync(out, dir, 0, dir.length); fs.writeSync(out, end, 0, end.length);
                fs.closeSync(out); out = null;
                fs.closeSync(fd); fd = null;
                fs.renameSync(temp, file);
                resolve({ files: files.length, size: position + dir.length + 22, distributor: !!certs.distributor });
            } catch (e) { fail(e); }
        }
    });
}

module.exports = { signPackage: signPackage, signatureXml: signatureXml, readDirectory: readDirectory, crc32: crc32, propObject: propObject };
