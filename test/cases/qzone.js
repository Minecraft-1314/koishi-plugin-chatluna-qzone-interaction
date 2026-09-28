'use strict'

const assert = require('node:assert/strict')
const { QzoneAuthError, QzoneValidationError } = require('qzone-sdk')

const rebindOptions = (overrides) => Object.assign({
    minIntervalSeconds: 60,
    backoffSeconds: 60,
    maxBackoffSeconds: 300,
    maxConsecutiveFailures: 3
}, overrides)

module.exports = (test, testAsync, { rebind, cookieSource, cookiePlatform, manager, fakeLogger }) => {
    testAsync('rebind 成功后清零失败计数', async () => {
        let now = 1000
        const c = new rebind.RebindController(rebindOptions({ nowSeconds: () => now }))
        await c.attempt(async () => { throw new Error('x') }).catch(() => {})
        assert.equal(c.stats().consecutiveFailures, 1)
        now += 1000
        await c.attempt(async () => {})
        assert.equal(c.stats().consecutiveFailures, 0)
        assert.ok(c.stats().lastSuccessAtSeconds !== null)
    })

    testAsync('rebind 触发过于频繁时被拒绝', async () => {
        const c = new rebind.RebindController(rebindOptions({ nowSeconds: () => 1000 }))
        await c.attempt(async () => {})
        await assert.rejects(() => c.attempt(async () => {}), /过于频繁/)
    })

    testAsync('rebind 退避指数增长并封顶后停用', async () => {
        let now = 0
        const c = new rebind.RebindController(rebindOptions({ nowSeconds: () => now, backoffSeconds: 60, maxBackoffSeconds: 300 }))
        for (const expected of [120, 240, 300]) {
            await c.attempt(async () => { throw new Error('x') }).catch(() => {})
            now = 0
            await assert.rejects(() => c.attempt(async () => {}))
            const s = c.stats()
            assert.equal(s.nextAllowedAtSeconds, s.lastAttemptAtSeconds + Math.max(60, expected))
        }
        assert.equal(c.stats().disabled, true)
        await assert.rejects(() => c.attempt(async () => {}), /已因连续失败停用/)
    })

    testAsync('rebind 并发调用共享同一次执行', async () => {
        let calls = 0
        let release
        const gate = new Promise((r) => { release = r })
        const c = new rebind.RebindController(rebindOptions({ nowSeconds: () => 0 }))
        const a = c.attempt(async () => { calls += 1; await gate })
        const b = c.attempt(async () => { calls += 1 })
        assert.equal(calls, 1)
        release()
        await Promise.all([a, b])
        assert.equal(calls, 1)
    })

    testAsync('rebind reset 恢复停用状态', async () => {
        const c = new rebind.RebindController(rebindOptions({ nowSeconds: () => 0 }))
        for (let i = 0; i < 3; i += 1) {
            await c.attempt(async () => { throw new Error('x') }).catch(() => {})
        }
        assert.equal(c.stats().disabled, true)
        c.reset()
        assert.equal(c.stats().disabled, false)
        assert.equal(c.stats().consecutiveFailures, 0)
    })

    test('rebind stats 在未尝试过时 nextAllowedAt 为 null', () => {
        const c = new rebind.RebindController(rebindOptions())
        assert.equal(c.stats().nextAllowedAtSeconds, null)
        assert.equal(c.stats().inFlight, false)
    })

    test('parseCookieHeader 解析并忽略畸形片段', () => {
        const jar = cookieSource.parseCookieHeader('a=1; b = 2 ;;=x; =y; p_skey=tk; ')
        assert.equal(jar.a, '1')
        assert.equal(jar.b, '2')
        assert.equal(jar.p_skey, 'tk')
        assert.equal(Object.keys(jar).length, 3)
    })

    test('extractUin 去除 o0 前缀并跳过非数字', () => {
        assert.equal(cookieSource.extractUin({ p_uin: 'o123456789' }), '123456789')
        assert.equal(cookieSource.extractUin({ p_uin: 'O123456789' }), '123456789')
        assert.equal(cookieSource.extractUin({ uin: 'abc', p_uin: '42' }), '42')
        assert.equal(cookieSource.extractUin({}), null)
        assert.equal(cookieSource.extractUin({ uin: '  ' }), null)
    })

    test('hasQzoneTicket 识别任一票据', () => {
        assert.equal(cookieSource.hasQzoneTicket({ p_skey: 'x' }), true)
        assert.equal(cookieSource.hasQzoneTicket({ skey: 'x' }), true)
        assert.equal(cookieSource.hasQzoneTicket({ skey2: 'x' }), true)
        assert.equal(cookieSource.hasQzoneTicket({ uin: '1' }), false)
    })

    testAsync('acquireQzoneCookies 逐域回退直到拿到票据', async () => {
        const tried = []
        const grant = await cookieSource.acquireQzoneCookies({
            platform: 'onebot',
            selfId: '1',
            getCookieHeader: async (domain) => {
                tried.push(domain)
                if (domain === 'user.qzone.qq.com') return 'uin=1; other=2'
                if (domain === 'qzone.qq.com') return 'uin=1; p_skey=tk'
                throw new Error('unsupported')
            },
            getLoginUin: async () => '9'
        })
        assert.equal(grant.accountId, '1')
        assert.equal(grant.domain, 'qzone.qq.com')
        assert.deepEqual(tried, ['user.qzone.qq.com', 'qzone.qq.com'])
    })

    testAsync('acquireQzoneCookies 无 uin 时回退到 loginUin', async () => {
        const grant = await cookieSource.acquireQzoneCookies({
            platform: 'onebot',
            selfId: '1',
            getCookieHeader: async () => 'p_skey=tk',
            getLoginUin: async () => 'o000777'
        })
        assert.equal(grant.accountId, '777')
    })

    testAsync('acquireQzoneCookies 全域失败时聚合原因抛出', async () => {
        await assert.rejects(() => cookieSource.acquireQzoneCookies({
            platform: 'onebot',
            selfId: '1',
            getCookieHeader: async (domain) => {
                if (domain === 'user.qzone.qq.com') return 'uin=1'
                throw new Error('boom')
            },
            getLoginUin: async () => null
        }), (e) => {
            assert.equal(e.name, 'CookieAcquireError')
            assert.match(e.message, /缺少空间票据/)
            assert.match(e.message, /boom/)
            assert.match(e.message, /OneBot/)
            return true
        })
    })

    testAsync('acquireQzoneCookies 只查询一次 loginUin', async () => {
        let loginCalls = 0
        await cookieSource.acquireQzoneCookies({
            platform: 'onebot',
            selfId: '1',
            getCookieHeader: async () => 'p_skey=tk',
            getLoginUin: async () => { loginCalls += 1; return '5' }
        })
        assert.equal(loginCalls, 1)
    })

    const ONLINE = 1
    const OFFLINE = 0

    test('resolvePlatformOrder auto 优先 OneBot', () => {
        assert.deepEqual(cookiePlatform.resolvePlatformOrder('auto'), ['onebot', 'milky'])
        assert.deepEqual(cookiePlatform.resolvePlatformOrder('milky'), ['milky'])
    })

    test('selectCookieBotView 按协议优先级与在线状态选择', () => {
        const bots = [
            { platform: 'milky', selfId: 'a', status: ONLINE },
            { platform: 'onebot', selfId: 'b', status: OFFLINE },
            { platform: 'onebot', selfId: 'c', status: ONLINE }
        ]
        assert.equal(cookiePlatform.selectCookieBotView(bots, '', ['onebot', 'milky']).bot.selfId, 'c')
        assert.equal(cookiePlatform.selectCookieBotView(bots, '', ['milky']).bot.selfId, 'a')
        assert.equal(cookiePlatform.selectCookieBotView(bots, 'a', ['onebot', 'milky']).bot.selfId, 'a')
        assert.equal(cookiePlatform.selectCookieBotView(bots, 'zzz', ['onebot', 'milky']), null)
        assert.equal(cookiePlatform.selectCookieBotView([bots[1]], '', ['onebot']), null)
        assert.equal(cookiePlatform.selectCookieBotView([], '', ['onebot', 'milky']), null)
    })

    test('selectCookieBot 对不支持取 Cookie 的 Milky 返回 null', () => {
        assert.equal(cookiePlatform.selectCookieBot([{ platform: 'milky', selfId: 'a', status: ONLINE, internal: {} }], '', ['milky']), null)
    })

    testAsync('OneBot 适配器直连并在 loginInfo 异常时回退 null', async () => {
        const ok = cookiePlatform.selectCookieBot([{ platform: 'onebot', selfId: 'a', status: ONLINE, internal: { getCookies: async () => 'p_skey=tk', getLoginInfo: async () => ({ user_id: '7' }) } }], '', ['onebot'])
        assert.equal(await ok.getCookieHeader('user.qzone.qq.com'), 'p_skey=tk')
        assert.equal(await ok.getLoginUin(), '7')
        const bad = cookiePlatform.selectCookieBot([{ platform: 'onebot', selfId: 'a', status: ONLINE, internal: { getCookies: async () => 'x', getLoginInfo: async () => { throw new Error('no') } } }], '', ['onebot'])
        assert.equal(await bad.getLoginUin(), null)
    })

    testAsync('Milky 适配器解析对象式 Cookie 并回退到包装式调用', async () => {
        const calls = []
        const bot = cookiePlatform.adaptMilkyCookieBot({
            selfId: 'a',
            internal: {
                get_cookies: async (arg) => {
                    calls.push(JSON.stringify(arg))
                    if (typeof arg === 'string') return { cookies: { p_skey: 'tk' } }
                    return { data: [{ name: 'p_skey', value: 'tk2' }] }
                },
                get_login_info: async () => JSON.stringify({ uin: 12 })
            }
        })
        assert.equal(await bot.getCookieHeader('qzone.qq.com'), 'p_skey=tk')
        assert.equal(await bot.getLoginUin(), '12')
        assert.equal(calls.length, 2)
        assert.equal(cookiePlatform.adaptMilkyCookieBot({ selfId: 'a', internal: { nothing: 1 } }), null)
        assert.equal(cookiePlatform.adaptMilkyCookieBot({ internal: { get_cookies: async () => null } }), null)
    })

    testAsync('Milky 适配器完全拿不到 Cookie 时抛出可读错误', async () => {
        const bot = cookiePlatform.adaptMilkyCookieBot({ selfId: 'a', internal: { getCookies: async () => null, get_cookies: async () => null } })
        await assert.rejects(() => bot.getCookieHeader('qzone.qq.com'), /get_cookies/)
    })

    const newManager = (overrides) => new manager.QzoneManager(Object.assign({
        acquire: async () => ({ cookies: 'p_skey=tk', accountId: '1', domain: 'qzone.qq.com' }),
        createClient: () => ({ getSessionInfo: () => null, close: async () => {} }),
        logger: fakeLogger(),
        rebind: rebindOptions()
    }, overrides))

    testAsync('manager 读操作遇鉴权失败续绑后重试一次', async () => {
        let calls = 0
        const m = newManager({
            createClient: () => ({
                listFeeds: async () => { calls += 1; if (calls === 1) throw new QzoneAuthError('expired'); return { items: [], nextCursor: null } },
                updateSession: async () => {},
                getSessionInfo: () => ({ accountId: '1', authenticated: true, updatedAt: null, persistencePending: false }),
                close: async () => {}
            })
        })
        assert.equal((await m.listFeedPage({ scope: 'self', limit: 5 })).items.length, 0)
        assert.equal(calls, 2)
    })

    testAsync('manager 写操作鉴权失败时不重试只抛鉴权错误', async () => {
        let calls = 0
        const m = newManager({
            createClient: () => ({
                comment: async () => { calls += 1; throw new QzoneAuthError('expired') },
                updateSession: async () => {},
                getSessionInfo: () => ({ accountId: '1', authenticated: true, updatedAt: null, persistencePending: false }),
                close: async () => {}
            })
        })
        await assert.rejects(() => m.comment({ post: { id: 'p', authorId: 'u' }, content: 'x' }), (e) => {
            assert.equal(e.name, 'QzoneWriteAuthError')
            assert.equal(e.operation, 'comment')
            assert.equal(e.rebound, true)
            return true
        })
        assert.equal(calls, 1)
    })

    testAsync('manager 非鉴权错误原样抛出且不触发续绑', async () => {
        const m = newManager({
            createClient: () => ({
                getPost: async () => { throw new QzoneValidationError('bad') },
                updateSession: async () => {},
                getSessionInfo: () => ({ accountId: null, authenticated: false, updatedAt: null, persistencePending: false }),
                close: async () => {}
            })
        })
        await assert.rejects(() => m.getPost({ post: { id: 'p', authorId: 'u' } }), /bad/)
        assert.equal(m.status().rebind.lastAttemptAtSeconds, null)
    })

    testAsync('manager 关闭后拒绝新建客户端', async () => {
        let created = 0
        const m = newManager({ createClient: () => { created += 1; return { getSessionInfo: () => null, close: async () => {} } } })
        await m.close()
        await assert.rejects(() => m.listFeedPage({ scope: 'self', limit: 1 }), /已随插件停止释放/)
        assert.equal(created, 0)
    })

    testAsync('manager 并发读共享同一次客户端初始化', async () => {
        let created = 0
        const m = newManager({
            acquire: async () => {
                await new Promise((r) => setTimeout(r, 5))
                return { cookies: 'p_skey=tk', accountId: '1', domain: 'qzone.qq.com' }
            },
            createClient: () => { created += 1; return { listFeeds: async () => ({ items: [], nextCursor: null }), getSessionInfo: () => null, close: async () => {} } }
        })
        await Promise.all([m.listFeedPage({ scope: 'self', limit: 1 }), m.listFeedPage({ scope: 'friends', limit: 1 })])
        assert.equal(created, 1)
    })

    testAsync('manager profile 缺少 userId 时立即报错', async () => {
        await assert.rejects(() => newManager().listFeedPage({ scope: 'profile', limit: 1 }), /需要提供 QQ 号/)
    })

    testAsync('manager 续绑被拒时读操作抛出原始鉴权错误', async () => {
        const m = newManager({
            acquire: async () => { throw new Error('no cookie') },
            createClient: () => ({ listFeeds: async () => { throw new QzoneAuthError('expired') }, updateSession: async () => {}, getSessionInfo: () => null, close: async () => {} })
        })
        await assert.rejects(() => m.listFeedPage({ scope: 'self', limit: 1 }), (e) => {
            assert.equal(e.name, 'QzoneAuthError')
            return true
        })
    })

    test('QzoneWriteAuthError 文案区分续绑成功与不可用', () => {
        assert.match(new manager.QzoneWriteAuthError('publish', true).message, /续绑已完成/)
        assert.match(new manager.QzoneWriteAuthError('like', false).message, /续绑不可用/)
    })
}
