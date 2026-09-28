'use strict'

const assert = require('node:assert/strict')

module.exports = (test, testAsync, { decision, xmlDecision, digestGenerator }) => {
    test('parseLikeFlag 接受多种写法且拒绝非法值', () => {
        for (const v of ['true', 'TRUE', ' 1 ', 'yes', '是']) assert.equal(decision.parseLikeFlag(v), true, v)
        for (const v of ['false', '0', 'no', '否']) assert.equal(decision.parseLikeFlag(v), false, v)
        assert.equal(decision.parseLikeFlag('maybe'), null)
        assert.equal(decision.parseLikeFlag(''), null)
    })

    test('resolveDecision off 模式一律不发布不点赞', () => {
        const r = decision.resolveDecision({ action: 'publish', like: true, content: 'hi' }, { commentMode: 'off', likeMode: 'off' })
        assert.deepEqual(r.value, { publish: false, like: false, content: null })
        assert.equal(r.error, null)
    })

    test('resolveDecision forced 模式忽略模型的 skip 与 like=false', () => {
        const r = decision.resolveDecision({ action: 'skip', like: false, content: 'forced text' }, { commentMode: 'forced', likeMode: 'forced' })
        assert.deepEqual(r.value, { publish: true, like: true, content: 'forced text' })
    })

    test('resolveDecision forced 模式缺正文时报错而不是静默跳过', () => {
        const r = decision.resolveDecision({ action: 'skip' }, { commentMode: 'forced', likeMode: 'off' })
        assert.equal(r.value, null)
        assert.match(r.error, /content/)
    })

    test('resolveDecision decide 模式尊重 skip 且不产生内容', () => {
        const r = decision.resolveDecision({ action: 'skip', content: 'ignored' }, { commentMode: 'decide', likeMode: 'off' })
        assert.deepEqual(r.value, { publish: false, like: false, content: null })
    })

    test('resolveDecision decide 模式缺 action 时按有无内容推断', () => {
        assert.deepEqual(decision.resolveDecision({ content: '  hello  ' }, { commentMode: 'decide', likeMode: 'off' }).value, { publish: true, like: false, content: 'hello' })
        assert.equal(decision.resolveDecision({}, { commentMode: 'decide', likeMode: 'off' }).value.publish, false)
    })

    test('resolveDecision likeMode=decide 时只认显式 true', () => {
        assert.equal(decision.resolveDecision({ like: true }, { commentMode: 'off', likeMode: 'decide' }).value.like, true)
        assert.equal(decision.resolveDecision({ like: false }, { commentMode: 'off', likeMode: 'decide' }).value.like, false)
        assert.equal(decision.resolveDecision({}, { commentMode: 'off', likeMode: 'decide' }).value.like, false)
    })

    test('resolveDecision 结构非法时返回错误', () => {
        assert.equal(decision.resolveDecision({ action: 'nope' }, { commentMode: 'decide', likeMode: 'off' }).value, null)
        assert.equal(decision.resolveDecision('string', { commentMode: 'decide', likeMode: 'off' }).value, null)
    })

    test('interactionDecisionSchema 允许全部字段缺省', () => {
        const r = decision.resolveDecision({}, { commentMode: 'off', likeMode: 'off' })
        assert.equal(r.value.publish, false)
    })

    test('parseXmlDecision 缺契约块时报错', () => {
        const r = xmlDecision.parseXmlDecision('just text', true)
        assert.equal(r.value, null)
        assert.match(r.error, /qzone_decision/)
    })

    test('parseXmlDecision 解析 action/like/content 并解码实体', () => {
        const text = '<qzone_decision><action>publish</action><like>true</like><content>a &amp; b &lt;c&gt;</content></qzone_decision>'
        const r = xmlDecision.parseXmlDecision(text, true)
        assert.equal(r.value.action, 'publish')
        assert.equal(r.value.like, true)
        assert.equal(r.value.content, 'a & b <c>')
    })

    test('parseXmlDecision 非法 action/like 报错', () => {
        assert.equal(xmlDecision.parseXmlDecision('<qzone_decision><action>maybe</action><content>x</content></qzone_decision>', true).value, null)
        assert.equal(xmlDecision.parseXmlDecision('<qzone_decision><like>perhaps</like><content>x</content></qzone_decision>', true).value, null)
    })

    test('parseXmlDecision needsContent=false 时允许空正文', () => {
        const r = xmlDecision.parseXmlDecision('<qzone_decision><like>false</like></qzone_decision>', false)
        assert.equal(r.value.like, false)
        assert.equal(r.value.content, '')
    })

    test('parseXmlDecision needsContent=true 且 action=skip 时接受空正文', () => {
        const r = xmlDecision.parseXmlDecision('<qzone_decision><action>skip</action></qzone_decision>', true)
        assert.equal(r.value.action, 'skip')
        assert.equal(r.value.content, '')
    })

    test('parseXmlDecision needsContent=true 且既无正文又非 skip 时报错', () => {
        assert.equal(xmlDecision.parseXmlDecision('<qzone_decision><like>true</like></qzone_decision>', true).value, null)
    })

    test('parseXmlDecision 剥离代码围栏并取最后一个契约块', () => {
        const text = '```\n<qzone_decision><content>first</content></qzone_decision>\n```\n<qzone_decision><content>second</content></qzone_decision>'
        assert.equal(xmlDecision.parseXmlDecision(text, true).value.content, 'second')
    })

    test('parseXmlDecision 支持带属性的开标签与大小写混写', () => {
        const r = xmlDecision.parseXmlDecision('<QZone_Decision foo="bar"><CONTENT>ok</CONTENT></QZone_Decision>', true)
        assert.equal(r.value.content, 'ok')
    })

    test('readTag 遇到自闭合形态的开标签时不算命中', () => {
        assert.equal(xmlDecision.readTag('<content/>text', 'content').found, false)
    })

    test('extractDecisionBlock 在无闭合标签时返回 null', () => {
        assert.equal(xmlDecision.extractDecisionBlock('<qzone_decision><content>x</content>'), null)
    })

    test('buildDecisionContract 按模式裁剪标签', () => {
        const forced = xmlDecision.buildDecisionContract({ commentMode: 'forced', likeMode: 'off' })
        assert.ok(forced.includes('<content>'))
        assert.ok(!forced.includes('<action>'))
        assert.ok(!forced.includes('<like>'))
        const decide = xmlDecision.buildDecisionContract({ commentMode: 'decide', likeMode: 'decide' })
        assert.ok(decide.includes('<action>'))
        assert.ok(decide.includes('<like>'))
        const likeOnly = xmlDecision.buildDecisionContract({ commentMode: 'off', likeMode: 'decide' })
        assert.ok(!likeOnly.includes('<content>'))
        assert.ok(likeOnly.includes('<like>'))
    })

    test('parseDigestDecision 解析 publish 与 skip', () => {
        assert.equal(digestGenerator.parseDigestDecision('<qzone_digest><action>publish</action><content>x</content></qzone_digest>').value.publish, true)
        assert.equal(digestGenerator.parseDigestDecision('<qzone_digest><action>skip</action></qzone_digest>').value.publish, false)
        assert.equal(digestGenerator.parseDigestDecision('<qzone_digest><action>maybe</action></qzone_digest>').value, null)
        assert.equal(digestGenerator.parseDigestDecision('<qzone_digest></qzone_digest>').value, null)
        assert.equal(digestGenerator.parseDigestDecision('nothing').value, null)
    })

    test('parseDigestDecision 缺 action 但有 content 时视为 publish', () => {
        assert.equal(digestGenerator.parseDigestDecision('<qzone_digest><content>x</content></qzone_digest>').value.publish, true)
    })

    test('parseDigestDecision 空白 content 视为缺失', () => {
        assert.equal(digestGenerator.parseDigestDecision('<qzone_digest><action>publish</action><content>   </content></qzone_digest>').value, null)
    })
}
