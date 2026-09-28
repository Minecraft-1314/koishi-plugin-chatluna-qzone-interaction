'use strict'

const assert = require('node:assert/strict')
const { QzoneAuthError, QzoneNotFoundError, QzoneValidationError } = require('qzone-sdk')

const state = require('../lib/auto-interaction/state')
const decision = require('../lib/auto-interaction/decision')
const concurrency = require('../lib/auto-interaction/concurrency')
const errors = require('../lib/auto-interaction/errors')
const xmlDecision = require('../lib/model/xml-decision')
const selfClosing = require('../lib/xml-tool/self-closing')
const promptTemplate = require('../lib/model/prompt-template')
const promptFormat = require('../lib/model/prompt-format')
const rebind = require('../lib/qzone/rebind')
const cookieSource = require('../lib/qzone/cookie-source')
const cookiePlatform = require('../lib/qzone/cookie-platform')
const manager = require('../lib/qzone/manager')
const media = require('../lib/auto-interaction/media')
const publishConstants = require('../lib/publish/constants')
const publishImages = require('../lib/publish/images')
const digestRuntime = require('../lib/digest/runtime')
const memorySource = require('../lib/digest/memory-source')
const digestGenerator = require('../lib/digest/generator')
const chatluna = require('../lib/chatluna')
const persona = require('../lib/persona')

const passed = []
const failures = []

const test = (name, fn) => {
    try {
        const result = fn()
        if (result && typeof result.then === 'function') {
            throw new Error('async test must use testAsync')
        }
        passed.push(name)
    } catch (error) {
        failures.push({ name, error })
    }
}

const testAsync = async (name, fn) => {
    try {
        await fn()
        passed.push(name)
    } catch (error) {
        failures.push({ name, error })
    }
}

const user = (id, nickname) => ({ id, nickname: nickname || 'n' + id })
const ref = (id, authorId) => ({ id, authorId })

const post = (overrides) => Object.assign({
    id: 'p1',
    authorId: 'u1',
    author: user('u1'),
    content: 'hello',
    createdAt: '2026-01-01T00:00:00.000Z',
    likeCount: 0,
    commentCount: 0,
    liked: false,
    media: [],
    comments: [],
    commentsComplete: true
}, overrides)

const comment = (overrides) => Object.assign({
    id: 'c1',
    author: user('u2'),
    content: 'nice',
    createdAt: '2026-01-01T00:00:01.000Z',
    parentId: null,
    threadRoot: null,
    replyTo: null,
    replyToUser: null,
    kind: 'comment'
}, overrides)

const fakeLogger = () => {
    const lines = []
    return {
        lines,
        debug: (m) => lines.push(['debug', m]),
        info: (m) => lines.push(['info', m]),
        warn: (m) => lines.push(['warn', m]),
        error: (m) => lines.push(['error', m])
    }
}

const run = async () => {
    require('./cases/state')(test, testAsync, { state, post, comment, user, ref })
    require('./cases/decision')(test, testAsync, { decision, xmlDecision, digestGenerator })
    require('./cases/text')(test, testAsync, { selfClosing, promptTemplate, promptFormat, errors })
    require('./cases/qzone')(test, testAsync, { rebind, cookieSource, cookiePlatform, manager, fakeLogger })
    require('./cases/media')(test, testAsync, { media, chatluna, user })
    require('./cases/publish')(test, testAsync, { publishConstants, publishImages })
    require('./cases/digest')(test, testAsync, { digestRuntime, memorySource, digestGenerator, fakeLogger })
    require('./cases/misc')(test, testAsync, { concurrency, persona, QzoneNotFoundError, state })
    return { passed, failures }
}

module.exports = { run }

if (require.main === module) {
    run().then(({ passed: ok, failures: bad }) => {
        for (const f of bad) {
            console.error('FAIL: ' + f.name)
            console.error('      ' + (f.error && f.error.message))
        }
        console.log('')
        console.log('passed=' + ok.length + ' failed=' + bad.length)
        process.exit(bad.length === 0 ? 0 : 1)
    })
}
