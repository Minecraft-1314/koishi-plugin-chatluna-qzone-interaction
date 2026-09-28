'use strict'

const assert = require('node:assert/strict')

const toArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

module.exports = (test, testAsync, { publishConstants, publishImages }) => {
    test('truncateContent 归一化换行并在超限时截断', () => {
        assert.deepEqual(publishConstants.truncateContent('  a\r\nb  '), { text: 'a\nb', truncated: false })
        const long = publishConstants.truncateContent('x'.repeat(6000))
        assert.equal(long.truncated, true)
        assert.equal(long.text.length, 5000 + publishConstants.CONTENT_TRUNCATED_SUFFIX.length)
        assert.ok(long.text.endsWith(publishConstants.CONTENT_TRUNCATED_SUFFIX))
        assert.equal(publishConstants.truncateContent('short', 2).text, 'sh' + publishConstants.CONTENT_TRUNCATED_SUFFIX)
    })

    test('truncateContent 空串返回空文本且标记未截断', () => {
        assert.deepEqual(publishConstants.truncateContent('   '), { text: '', truncated: false })
    })

    test('collectImageUrls 只收集 img 且去重', () => {
        const els = [
            { type: 'text', attrs: {} },
            { type: 'img', attrs: { src: 'https://a/1.png' } },
            { type: 'img', attrs: { src: 'https://a/1.png' } },
            { type: 'img', attrs: { src: '   ' } },
            { type: 'img', attrs: {} },
            { type: 'img', attrs: { src: 123 } },
            null
        ]
        assert.deepEqual(publishImages.collectImageUrls(els), ['https://a/1.png'])
    })

    test('extractImageUrls 截断到上限', () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ type: 'img', attrs: { src: 'https://a/' + i + '.png' } }))
        assert.equal(publishImages.extractImageUrls(many).length, publishConstants.PUBLISH_MAX_IMAGES)
    })

    test('isRemoteImageUrl 限定 http(s)', () => {
        assert.equal(publishImages.isRemoteImageUrl('https://a'), true)
        assert.equal(publishImages.isRemoteImageUrl('http://a'), true)
        assert.equal(publishImages.isRemoteImageUrl('ftp://a'), false)
        assert.equal(publishImages.isRemoteImageUrl('data:image/png;base64,AA'), false)
    })

    test('formatBytes 三档单位', () => {
        assert.equal(publishImages.formatBytes(512), '512B')
        assert.equal(publishImages.formatBytes(2048), '2.0KB')
        assert.equal(publishImages.formatBytes(5 * 1024 * 1024), '5.0MB')
    })

    testAsync('fetchPublishImages 汇总成功与失败且不抛出', async () => {
        const res = await publishImages.fetchPublishImages({
            http: {
                get: async (url) => {
                    if (url === 'bad') return { data: new ArrayBuffer(0), headers: { 'content-type': 'image/png' } }
                    if (url === 'ftp://x') throw new Error('never')
                    return { data: toArrayBuffer(new Uint8Array([1, 2])), headers: { 'content-type': 'image/png' } }
                }
            }
        }, ['https://a/1.png', 'ftp://x', 'bad'])
        assert.equal(res.images.length, 1)
        assert.equal(res.errors.length, 2)
        assert.match(res.errors[0], /仅支持 http\/https/)
        assert.match(res.errors[1], /内容为空/)
        assert.equal(res.images[0].input.name, 'image.png')
        assert.equal(res.images[0].input.mimeType, 'image/png')
    })

    testAsync('fetchPublishImages 从 content-type 与 URL 推断文件名', async () => {
        const res = await publishImages.fetchPublishImages({
            http: { get: async () => ({ data: toArrayBuffer(new Uint8Array([1])), headers: { 'content-type': 'image/PNG; charset=x' } }) }
        }, ['https://a/pic'])
        assert.equal(res.images[0].input.name, 'image.png')
        assert.equal(res.images[0].input.mimeType, 'image/png')
    })

    testAsync('fetchPublishImages 无 mime 且 URL 无扩展名时回退 bin', async () => {
        const res = await publishImages.fetchPublishImages({
            http: { get: async () => ({ data: toArrayBuffer(new Uint8Array([1])), headers: {} }) }
        }, ['https://a/pic'])
        assert.equal(res.images[0].input.name, 'image.bin')
        assert.equal(res.images[0].input.mimeType, undefined)
    })

    testAsync('fetchPublishImages 拒绝超大图片', async () => {
        const big = new Uint8Array(publishConstants.PUBLISH_MAX_IMAGE_BYTES + 1)
        const res = await publishImages.fetchPublishImages({
            http: { get: async (url) => (url === 'big' ? { data: toArrayBuffer(big), headers: {} } : { data: toArrayBuffer(new Uint8Array([1])), headers: {} }) }
        }, ['https://a/pic.JPEG?x=1', 'big'])
        assert.equal(res.images[0].input.name, 'image.jpeg')
        assert.match(res.errors[0], /32MB 上限/)
    })

    testAsync('fetchPublishImages 截断到图片上限', async () => {
        let fetched = 0
        const urls = Array.from({ length: publishConstants.PUBLISH_MAX_IMAGES + 4 }, (_, i) => 'https://a/' + i + '.png')
        const res = await publishImages.fetchPublishImages({
            http: { get: async () => { fetched += 1; return { data: toArrayBuffer(new Uint8Array([1])), headers: {} } } }
        }, urls)
        assert.equal(fetched, publishConstants.PUBLISH_MAX_IMAGES)
        assert.equal(res.images.length, publishConstants.PUBLISH_MAX_IMAGES)
    })

    test('PublishImageError 保留原始 url', () => {
        const e = new publishImages.PublishImageError('https://a/1.png', new Error('timeout'))
        assert.equal(e.url, 'https://a/1.png')
        assert.match(e.message, /https:\/\/a\/1\.png/)
        assert.match(e.message, /timeout/)
        assert.match(new publishImages.PublishImageError('u', 'str').message, /str/)
    })
}
