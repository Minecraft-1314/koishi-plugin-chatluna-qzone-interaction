'use strict'

const assert = require('node:assert/strict')

module.exports = (test, testAsync, { selfClosing, promptTemplate, promptFormat, errors }) => {
    test('parseSelfClosingXmlTags 解析属性与实体', () => {
        const tags = selfClosing.parseSelfClosingXmlTags('<qzone_publish content="a &amp; b" image2="u2" image1="u1" />', 'qzone_publish')
        assert.equal(tags.length, 1)
        assert.equal(tags[0].content, 'a & b')
        assert.equal(tags[0].image1, 'u1')
    })

    test('parseSelfClosingXmlTags 支持单引号与无引号属性', () => {
        const tags = selfClosing.parseSelfClosingXmlTags("<qzone_publish content='hi' image1=u1/>", 'qzone_publish')
        assert.equal(tags[0].content, 'hi')
        assert.equal(tags[0].image1, 'u1')
    })

    test('parseSelfClosingXmlTags 忽略非自闭合与空输入', () => {
        assert.deepEqual(selfClosing.parseSelfClosingXmlTags('<qzone_publish content="x">', 'qzone_publish'), [])
        assert.deepEqual(selfClosing.parseSelfClosingXmlTags('', 'qzone_publish'), [])
        assert.deepEqual(selfClosing.parseSelfClosingXmlTags(null, 'qzone_publish'), [])
    })

    test('parseSelfClosingXmlTags 连续多次调用无状态污染', () => {
        const text = '<qzone_publish content="a"/><qzone_publish content="b"/>'
        assert.equal(selfClosing.parseSelfClosingXmlTags(text, 'qzone_publish').length, 2)
        assert.equal(selfClosing.parseSelfClosingXmlTags(text, 'qzone_publish').length, 2)
    })

    test('decodeXmlEntities 处理数值实体与非法码点', () => {
        assert.equal(selfClosing.decodeXmlEntities('&#65;&#x42;'), 'AB')
        assert.equal(selfClosing.decodeXmlEntities('&#x110000;'), '')
        assert.equal(selfClosing.decodeXmlEntities('&amp;lt;'), '&lt;')
    })

    test('renderPromptTemplate 替换占位符且未知占位符为空', () => {
        assert.equal(promptTemplate.renderPromptTemplate('a {{x}} b {{ y }} {{z}}', { x: '1', y: '2' }), 'a 1 b 2 ')
    })

    test('templateHasPlaceholder 反复调用不因 lastIndex 残留出错', () => {
        const t = '{{task}} and {{contract}}'
        assert.equal(promptTemplate.templateHasPlaceholder(t, 'task'), true)
        assert.equal(promptTemplate.templateHasPlaceholder(t, 'task'), true)
        assert.equal(promptTemplate.templateHasPlaceholder(t, 'media'), false)
        assert.equal(promptTemplate.templateHasPlaceholder(t, 'media'), false)
    })

    test('appendMissingSections 只补齐模板未覆盖的段落', () => {
        const rendered = promptTemplate.appendMissingSections('base', '{{task}}', [
            { key: 'task', tag: 'task', value: 'T' },
            { key: 'media', tag: 'media_rules', value: 'M' },
            { key: 'writing', tag: 'writing_rules', value: '   ' }
        ])
        assert.ok(!rendered.includes('<task>'))
        assert.ok(rendered.includes('<media_rules>\nM\n</media_rules>'))
        assert.ok(!rendered.includes('<writing_rules>'))
    })

    test('appendMissingSections 无缺失段落时原样返回', () => {
        assert.equal(promptTemplate.appendMissingSections('X', '{{task}}', [{ key: 'task', tag: 'task', value: 'T' }]), 'X')
    })

    test('escapeXmlText 依次转义 & < >', () => {
        assert.equal(promptFormat.escapeXmlText('&<>'), '&amp;&lt;&gt;')
    })

    test('describeError 收集上下文与响应片段', () => {
        const e = new Error('boom')
        e.code = 'QZONE_AUTH'
        e.context = { statusCode: 401, serviceCode: 0, retryCount: 2, responseSnippet: 'a\n  b   c', endpoint: 'x' }
        const text = errors.describeError(e)
        assert.match(text, /Error: boom/)
        assert.match(text, /code=QZONE_AUTH/)
        assert.match(text, /statusCode=401/)
        assert.ok(text.includes('serviceCode=0'))
        assert.match(text, /response=a b c/)
        assert.equal(errors.describeError('str'), 'str')
    })

    test('describeError 截断超长响应片段', () => {
        const e = new Error('x')
        e.context = { responseSnippet: 'y'.repeat(500) }
        assert.ok(errors.describeError(e).length < 300)
    })

    test('safeStringify 处理循环引用与 undefined', () => {
        const circular = {}
        circular.self = circular
        assert.equal(errors.safeStringify(circular), null)
        assert.equal(errors.safeStringify({ a: 1 }), '{\n  "a": 1\n}')
        assert.equal(errors.safeStringify(undefined), String(undefined))
    })
}
