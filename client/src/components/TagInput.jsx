import { useState } from 'react'
import { Button, Flex, Input, Text } from '@chakra-ui/react'
import { MAX_TAGS, MAX_TAG_LENGTH, addTag, removeTag, splitTagInput } from '../soundList.js'

/**
 * タグ(複数)の入力。Enter・カンマ・入力欄から離れたときに確定し、確定済みのタグは ✕ で外せる。
 * 既存のタグ (suggestions) は、押すだけで足せる。
 *
 * @param {{
 *   tags: string[],
 *   onChange: (tags: string[]) => void,
 *   suggestions?: string[],
 *   disabled?: boolean,
 *   label?: string,
 * }} props
 */
export default function TagInput({ tags, onChange, suggestions = [], disabled = false, label = 'タグ' }) {
  const [text, setText] = useState('')
  const full = tags.length >= MAX_TAGS

  const commit = (value) => {
    const next = addTag(tags, value)
    if (next !== tags) onChange(next)
  }

  const handleChange = (value) => {
    const { done, rest } = splitTagInput(value)
    if (done.length > 0) {
      let next = tags
      for (const part of done) next = addTag(next, part)
      if (next !== tags) onChange(next)
    }
    setText(rest)
  }

  const flush = () => {
    if (text.trim()) commit(text)
    setText('')
  }

  const lowered = new Set(tags.map((t) => t.toLowerCase()))
  const unused = suggestions.filter((t) => !lowered.has(t.toLowerCase())).slice(0, 8)

  return (
    <Flex direction="column" gap="2">
      {tags.length > 0 && (
        <Flex gap="1" wrap="wrap" role="list" aria-label={`${label}一覧`}>
          {tags.map((tag) => (
            <Button
              key={tag}
              role="listitem"
              size="2xs"
              variant="subtle"
              disabled={disabled}
              onClick={() => onChange(removeTag(tags, tag))}
              aria-label={`タグ ${tag} を外す`}
            >
              {tag} ✕
            </Button>
          ))}
        </Flex>
      )}
      <Input
        size="sm"
        value={text}
        placeholder={full ? `タグは${MAX_TAGS}個までです` : 'タグを入力して Enter (カンマ区切りも可)'}
        maxLength={MAX_TAG_LENGTH}
        disabled={disabled || full}
        aria-label={label}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault() // 変換確定の Enter では確定しない
            flush()
          }
        }}
        onBlur={flush}
      />
      {unused.length > 0 && !full && (
        <Flex gap="1" wrap="wrap" align="center">
          <Text fontSize="xs" color="fg.muted">
            既存:
          </Text>
          {unused.map((tag) => (
            <Button key={tag} size="2xs" variant="outline" disabled={disabled} onClick={() => commit(tag)}>
              ＋{tag}
            </Button>
          ))}
        </Flex>
      )}
    </Flex>
  )
}
