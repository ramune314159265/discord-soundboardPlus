import { Button, Flex, Text } from '@chakra-ui/react'
import { useAtom, useAtomValue } from 'jotai'
import { selectedTagsAtom, tabSoundsAtom } from '../state.js'
import { collectTags } from '../soundList.js'

/** 一覧の上のタグ絞り込み。選んだタグを「すべて」持つサウンドだけ表示する */
export default function TagFilter() {
  const sounds = useAtomValue(tabSoundsAtom)
  const [selected, setSelected] = useAtom(selectedTagsAtom)
  const tags = collectTags(sounds)
  if (tags.length === 0) return null

  const toggle = (tag) => setSelected(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag])

  return (
    <Flex gap="2" wrap="wrap" align="center" aria-label="タグで絞り込み" role="group">
      <Text fontSize="xs" color="fg.muted" flexShrink="0">
        タグ:
      </Text>
      {tags.map(({ tag, count }) => {
        const on = selected.includes(tag)
        return (
          <Button
            key={tag}
            size="xs"
            borderRadius="full"
            variant={on ? 'solid' : 'outline'}
            aria-pressed={on}
            data-tag-filter={tag}
            onClick={() => toggle(tag)}
          >
            {tag}
            <Text as="span" opacity="0.7" fontSize="2xs">
              {count}
            </Text>
          </Button>
        )
      })}
      {selected.length > 0 && (
        <Button size="xs" variant="ghost" onClick={() => setSelected([])}>
          絞り込みを解除
        </Button>
      )}
    </Flex>
  )
}
