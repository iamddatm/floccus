/* global globalThis */
import { expect } from 'chai'
import { Bookmark, ItemLocation } from '../lib/Tree'

/**
 * 360极速浏览器X 的书签写入接口整体失效:create / move / update / remove 一律返回
 * "Bookmark id is invalid.",而读取 API 正常。这里用一个同样行为的 chrome.bookmarks 桩
 * 来验证 BrowserTree 会把这种情况报成 E058(而不是含糊的"无法创建某书签"),也不会把
 * 被拒绝的删除当成成功吞掉;同时验证真正的问题(父节点不存在)仍然报原来的错误。
 */

/** 安装一个回调式、行为可切换的 chrome.bookmarks 桩;browser-api.js 在导入时就会读取 chrome */
function installBrowserStub() {
  const state = { brokenWrites: false, writeError: 'Bookmark id is invalid.' }

  const chrome = {
    runtime: { lastError: null },
    i18n: { getMessage: (name) => name },
    bookmarks: {},
  }

  // 和 Chromium 一样:lastError 只在回调期间有值
  const succeed = (cb, ...args) => {
    chrome.runtime.lastError = null
    cb(...args)
  }
  const fail = (cb, message) => {
    chrome.runtime.lastError = { message }
    cb()
    chrome.runtime.lastError = null
  }
  // 写入类调用:桩坏了就一律按 360 那样拒绝
  const write = (cb, result) => state.brokenWrites ? fail(cb, state.writeError) : succeed(cb, result)

  chrome.bookmarks.get = (ids, cb) => {
    const list = Array.isArray(ids) ? ids : [ids]
    if (list.some((id) => String(id).startsWith('bogus'))) {
      return fail(cb, "Can't find bookmark for id.")
    }
    return succeed(cb, list.map((id) => ({ id: String(id), title: 'node ' + id })))
  }
  chrome.bookmarks.getSubTree = (id, cb) => succeed(cb, [{ id: String(id), children: [] }])
  chrome.bookmarks.create = (details, cb) => write(cb, { id: '900', ...details })
  chrome.bookmarks.move = (id, details, cb) => write(cb)
  chrome.bookmarks.update = (id, changes, cb) => write(cb, { id, ...changes })
  chrome.bookmarks.remove = (id, cb) => write(cb)
  chrome.bookmarks.removeTree = (id, cb) => write(cb)

  globalThis.chrome = chrome
  return state
}

const newBookmark = (parentId) => new Bookmark({
  location: ItemLocation.LOCAL,
  id: undefined,
  parentId,
  title: 'a bookmark',
  url: 'https://example.com/',
})

describe('BrowserTree in a browser that rejects all bookmark writes (360极速浏览器X)', function() {
  let BrowserTree
  let LocalBookmarkWritesUnsupportedError
  let state

  before(async function() {
    state = installBrowserStub()
    BrowserTree = (await import('../lib/browser/BrowserTree')).default
    LocalBookmarkWritesUnsupportedError = (await import('../errors/Error')).LocalBookmarkWritesUnsupportedError
  })

  beforeEach(function() {
    state.brokenWrites = true
  })

  const catchError = async(fn) => {
    try {
      await fn()
      return null
    } catch (e) {
      return e
    }
  }

  /** 构造函数异步解析绝对根文件夹(真实使用里由 getBookmarksTree 等待),这里等一个 tick */
  const newTree = async() => {
    const tree = new BrowserTree('Dummy Storage', '1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    return tree
  }

  it('reports E058 when a create is rejected although the parent folder exists', async function() {
    const tree = await newTree()

    const error = await catchError(() => tree.createBookmark(newBookmark('331')))

    expect(error).to.be.instanceOf(LocalBookmarkWritesUnsupportedError)
    expect(error.code).to.equal(58)
    expect(error.message).to.contain('E058')
  })

  it('reports E058 when a rejected remove would otherwise be swallowed', async function() {
    const tree = await newTree()

    const error = await catchError(() => tree.removeBookmark({ ...newBookmark('331'), id: '343' }))

    expect(error).to.be.instanceOf(LocalBookmarkWritesUnsupportedError)
  })

  it('keeps the plain error when the id it used really does not exist', async function() {
    const tree = await newTree()

    const error = await catchError(() => tree.createBookmark(newBookmark('bogus-parent')))

    expect(error).to.not.be.instanceOf(LocalBookmarkWritesUnsupportedError)
    expect(error.message).to.contain('Could not create')
    expect(error.message).to.contain('Bookmark id is invalid.')
  })

  it('creates bookmarks when the browser writes them', async function() {
    state.brokenWrites = false
    const tree = await newTree()

    const id = await tree.createBookmark(newBookmark('331'))

    expect(id).to.equal('900')
  })
})