'use strict'

const assert = require('node:assert/strict')

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const toArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

const httpReturning = (bytes) => ({ get: async () => toArrayBuffer(bytes) })

const imageModel = (overrides) => Object.assign({
    modelName: 'm',
    modelInfo: { capabilities: ['image_input'] },
    fileHandlingConfig: { supportedMimeTypes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']) },
    invoke: async () => ({ content: '' })
}, overrides)

const textOnlyModel = { modelName: 'm', modelInfo: { capabilities: [] }, fileHandlingConfig: null, invoke: async () => ({ content: '' }) }

const image = (url, extra) => Object.assign({ kind: 'image', url }, extra)

module.exports = (test, testAsync, { media, chatluna }) => {
    test('declaresImageInput / acceptsMime / supportsDirectImageMime', () => {
        const m = imageModel()
        assert.equal(media.declaresImageInput(m), true)
        assert.equal(media.acceptsMime(m, 'image/png'), true)
        assert.equal(media.acceptsMime(m, 'image/avif'), false)
        assert.equal(media.supportsDirectImageMime(m, 'image/png'), true)
        assert.equal(media.supportsDirectImageMime(m, 'image/gif'), false)
        assert.equal(media.supportsDirectImageMime(imageModel({ fileHandlingConfig: { supportedMimeTypes: new Set() } }), 'image/png'), false)
        assert.equal(media.supportsDirectImageMime(textOnlyModel, 'image/png'), false)
    })

    test('declaresImageInput 对缺失 modelInfo 宽容', () => {
        assert.equal(media.declaresImageInput({ modelName: 'x', fileHandlingConfig: null, invoke: async () => ({}) }), false)
        assert.equal(media.declaresImageInput(imageModel({ modelInfo: {} })), false)
    })

    testAsync('prepareInteractionMedia 附加可直传图片并输出元数据行', async () => {
        const res = await media.prepareInteractionMedia(
            httpReturning(PNG),
            [image('https://x/1.png', { name: 'a.png' })],
            imageModel(),
            null,
            null
        )
        assert.equal(res.imageParts.length, 1)
        assert.ok(res.imageParts[0].image_url.url.startsWith('data:image/png;base64,'))
        assert.equal(res.storageFallbacks, 0)
        assert.match(res.lines[0], /status=attached/)
        assert.match(res.lines[0], /media_id=M1/)
        assert.equal(res.descriptions.size, 0)
    })

    testAsync('prepareInteractionMedia 非图片媒体只输出元数据且不下载', async () => {
        const res = await media.prepareInteractionMedia(
            { get: async () => { throw new Error('should not fetch') } },
            [{ kind: 'video', url: 'https://x/v.mp4', durationMs: 1000 }],
            imageModel(),
            null,
            null
        )
        assert.equal(res.imageParts.length, 0)
        assert.match(res.lines[0], /status=metadata-only/)
        assert.match(res.lines[0], /durationMs=1000/)
    })

    testAsync('prepareInteractionMedia 模型不支持图片时交给描述通道', async () => {
        const described = []
        const res = await media.prepareInteractionMedia(
            { get: async () => { throw new Error('no') } },
            [image('https://x/1.png')],
            textOnlyModel,
            async (urls) => { described.push(...urls); return ['一张图'] },
            null
        )
        assert.equal(res.imageParts.length, 0)
        assert.deepEqual(described, ['https://x/1.png'])
        assert.equal(res.descriptions.get('M1'), '一张图')
        assert.match(res.lines[0], /status=described/)
    })

    testAsync('prepareInteractionMedia 超过图片上限时不多下载', async () => {
        let fetched = 0
        const items = Array.from({ length: media.INTERACTION_IMAGE_LIMIT + 2 }, (_, i) => image('https://x/' + i + '.png'))
        const res = await media.prepareInteractionMedia(
            { get: async () => { fetched += 1; return toArrayBuffer(PNG) } },
            items,
            imageModel(),
            null,
            null
        )
        assert.equal(res.imageParts.length, media.INTERACTION_IMAGE_LIMIT)
        assert.equal(fetched, media.INTERACTION_IMAGE_LIMIT)
        assert.equal(res.lines.length, items.length)
        assert.match(res.lines[items.length - 1], /image-count-limit/)
    })

    testAsync('prepareInteractionMedia 单图超限时降级为 unresolved', async () => {
        const res = await media.prepareInteractionMedia(
            httpReturning(PNG),
            [image('https://x/1.png')],
            imageModel({ fileHandlingConfig: { supportedMimeTypes: new Set(['image/png']), maxFileSizeBytes: 4 } }),
            null,
            null
        )
        assert.equal(res.imageParts.length, 0)
        assert.match(res.lines[0], /image-size-limit/)
    })

    testAsync('prepareInteractionMedia 单图分类型上限优先于通用上限', async () => {
        const res = await media.prepareInteractionMedia(
            httpReturning(PNG),
            [image('https://x/1.png')],
            imageModel({ fileHandlingConfig: { supportedMimeTypes: new Set(['image/png']), maxFileSizeBytes: 9999, maxFileSizeBytesOverrides: { 'image/png': 4 } } }),
            null,
            null
        )
        assert.equal(res.imageParts.length, 0)
        assert.match(res.lines[0], /image-size-limit/)
    })

    testAsync('prepareInteractionMedia 总量超限时后续图片降级', async () => {
        const res = await media.prepareInteractionMedia(
            httpReturning(PNG),
            [image('https://x/1.png'), image('https://x/2.png')],
            imageModel({ fileHandlingConfig: { supportedMimeTypes: new Set(['image/png']), maxTotalSizeBytes: 4 } }),
            null,
            null
        )
        assert.equal(res.imageParts.length, 1)
        assert.match(res.lines[1], /total-size-limit/)
    })

    testAsync('prepareInteractionMedia 模型可读格式但模型不接收该 mime 时降级', async () => {
        const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2])
        const res = await media.prepareInteractionMedia(
            httpReturning(gif),
            [image('https://x/1.gif')],
            imageModel({ fileHandlingConfig: { supportedMimeTypes: new Set(['image/png']) } }),
            null,
            null
        )
        assert.equal(res.imageParts.length, 0)
        assert.match(res.lines[0], /actual_mime=image\/gif/)
        assert.match(res.lines[0], /mime-not-supported-directly/)
    })

    testAsync('prepareInteractionMedia 下载失败时记录并降级', async () => {
        const res = await media.prepareInteractionMedia(
            { get: async () => { throw new Error('offline') } },
            [image('https://x/1.png')],
            imageModel(),
            null,
            null
        )
        assert.equal(res.imageParts.length, 0)
        assert.deepEqual(res.downloadFailedMedia, ['M1'])
        assert.match(res.lines[0], /download-or-format/)
    })

    testAsync('prepareInteractionMedia 拒绝非 http(s)、空内容与未知格式', async () => {
        const res = await media.prepareInteractionMedia(
            {
                get: async (url) => {
                    if (url === 'file:///x') throw new Error('协议不受支持')
                    if (url === 'https://x/empty') return new ArrayBuffer(0)
                    if (url === 'https://x/unknown') return toArrayBuffer(new Uint8Array([1, 2, 3, 4]))
                    throw new Error('unexpected')
                }
            },
            [image('file:///x'), image('https://x/empty'), image('https://x/unknown')],
            imageModel(),
            null,
            null
        )
        assert.equal(res.imageParts.length, 0)
        assert.deepEqual(res.downloadFailedMedia, ['M1', 'M2', 'M3'])
    })

    testAsync('prepareInteractionMedia storage 成功时使用中转地址', async () => {
        const res = await media.prepareInteractionMedia(
            httpReturning(PNG),
            [image('https://x/1.png')],
            imageModel(),
            null,
            {
                createTempFile: async (_buf, name, expire, mime) => {
                    assert.equal(name, 'M1.png')
                    assert.equal(expire, 1)
                    assert.equal(mime, 'image/png')
                    return { url: 'https://relay/1.png' }
                }
            }
        )
        assert.equal(res.imageParts[0].image_url.url, 'https://relay/1.png')
        assert.equal(res.storageFallbacks, 0)
    })

    testAsync('prepareInteractionMedia storage 失败时回退 base64 并计数', async () => {
        const res = await media.prepareInteractionMedia(
            httpReturning(PNG),
            [image('https://x/1.png')],
            imageModel(),
            null,
            { createTempFile: async () => { throw new Error('no server') } }
        )
        assert.equal(res.storageFallbacks, 1)
        assert.ok(res.imageParts[0].image_url.url.startsWith('data:'))
    })

    testAsync('prepareInteractionMedia storage 失败且已中止时向上抛出', async () => {
        const controller = new AbortController()
        controller.abort()
        await assert.rejects(() => media.prepareInteractionMedia(
            httpReturning(PNG),
            [image('https://x/1.png')],
            imageModel(),
            null,
            { createTempFile: async () => { throw new Error('aborted') } },
            controller.signal
        ))
    })

    testAsync('prepareInteractionMedia 描述通道抛错时静默降级', async () => {
        const res = await media.prepareInteractionMedia(
            { get: async () => { throw new Error('x') } },
            [image('https://x/1.png')],
            textOnlyModel,
            async () => { throw new Error('describe down') },
            null
        )
        assert.equal(res.descriptions.size, 0)
        assert.match(res.lines[0], /status=unresolved/)
    })

    testAsync('prepareInteractionMedia 描述返回空串或缺项时不写入描述表', async () => {
        const blank = await media.prepareInteractionMedia(
            { get: async () => { throw new Error('x') } },
            [image('https://x/1.png')],
            textOnlyModel,
            async () => ['   '],
            null
        )
        assert.equal(blank.descriptions.size, 0)
        const short = await media.prepareInteractionMedia(
            { get: async () => { throw new Error('x') } },
            [image('https://x/1.png')],
            textOnlyModel,
            async () => [],
            null
        )
        assert.equal(short.descriptions.size, 0)
    })

    testAsync('prepareInteractionMedia 空媒体列表返回空结果', async () => {
        const res = await media.prepareInteractionMedia({ get: async () => { throw new Error('x') } }, [], imageModel(), null, null)
        assert.deepEqual(res.lines, [])
        assert.deepEqual(res.imageParts, [])
        assert.equal(res.descriptions.size, 0)
    })

    test('base64EncodedSize 计算正确且非法输入返回 0', () => {
        assert.equal(chatluna.base64EncodedSize(3), 4)
        assert.equal(chatluna.base64EncodedSize(4), 8)
        assert.equal(chatluna.base64EncodedSize(0), 0)
        assert.equal(chatluna.base64EncodedSize(-1), 0)
        assert.equal(chatluna.base64EncodedSize(Number.NaN), 0)
        assert.equal(chatluna.base64EncodedSize(Number.POSITIVE_INFINITY), 0)
    })

    test('readChatLuna 在无服务时返回 undefined', () => {
        assert.equal(chatluna.readChatLuna({}), undefined)
        const fake = { chatluna: { a: 1 } }
        assert.equal(chatluna.readChatLuna(fake), fake.chatluna)
    })
}
