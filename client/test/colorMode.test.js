import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyColorMode, followDeviceColorMode } from '../src/colorMode.js'

function fakeRoot() {
  const classes = new Set()
  return {
    classes,
    style: { colorScheme: '' },
    classList: { toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)) },
  }
}

function fakeWindow(initialDark) {
  const listeners = new Set()
  const media = {
    matches: initialDark,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  }
  return {
    listeners,
    matchMedia: (query) => {
      assert.equal(query, '(prefers-color-scheme: dark)')
      return media
    },
    change(dark) {
      media.matches = dark
      for (const fn of [...listeners]) fn({ matches: dark })
    },
  }
}

test('applyColorMode: exactly one of dark / light, and the browser color-scheme follows', () => {
  const root = fakeRoot()
  applyColorMode(root, true)
  assert.deepEqual([...root.classes], ['dark'])
  assert.equal(root.style.colorScheme, 'dark')
  applyColorMode(root, false)
  assert.deepEqual([...root.classes], ['light'])
  assert.equal(root.style.colorScheme, 'light')
})

test('followDeviceColorMode: applies the device setting now and follows changes while open', () => {
  const win = fakeWindow(true)
  const root = fakeRoot()
  const stop = followDeviceColorMode(win, root)
  assert.deepEqual([...root.classes], ['dark'])
  win.change(false)
  assert.deepEqual([...root.classes], ['light'])
  win.change(true)
  assert.deepEqual([...root.classes], ['dark'])
  stop()
  assert.equal(win.listeners.size, 0)
  win.change(false)
  assert.deepEqual([...root.classes], ['dark'], 'no longer following after stop')
})

test('followDeviceColorMode: without matchMedia it stays light', () => {
  const root = fakeRoot()
  followDeviceColorMode({}, root)
  assert.deepEqual([...root.classes], ['light'])
})
