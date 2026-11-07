import { useState } from 'react'
import { Button, Card, Flex, Heading, Input } from '@chakra-ui/react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { editingSoundIdAtom, mySoundsAtom, sessionAtom, soundsAtom, toastAtom } from '../state.js'
import { lastGrapheme, MAX_NAME_LENGTH } from '../addSounds.js'
import { collectTags } from '../soundList.js'
import TagInput from './TagInput.jsx'

/** サウンドのタイトル・絵文字・タグを編集する (一覧の上に開く) */
function Editor({ sound, suggestions, onClose }) {
  const session = useAtomValue(sessionAtom)
  const setToast = useSetAtom(toastAtom)
  const [name, setName] = useState(sound.name)
  const [emoji, setEmoji] = useState(sound.emoji ?? '')
  const [tags, setTags] = useState(sound.tags ?? [])
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await session.api.updateSound(sound.id, { name: name.trim(), emoji: emoji.trim(), tags })
      setToast({ kind: 'info', text: `「${name.trim()}」を更新しました` })
      onClose()
    } catch (err) {
      setToast({ kind: 'error', text: err.message })
      setSaving(false)
    }
  }

  return (
    <Card.Root>
      <Card.Body>
        <Flex direction="column" gap="3">
          <Heading size="sm">サウンドを編集</Heading>
          <Flex gap="2">
            <Input
              value={emoji}
              onChange={(e) => setEmoji(lastGrapheme(e.target.value))}
              placeholder="🎉"
              w="72px"
              flexShrink="0"
              textAlign="center"
              disabled={saving}
              aria-label="絵文字"
            />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="サウンド名"
              maxLength={MAX_NAME_LENGTH}
              disabled={saving}
              aria-label="サウンド名"
              aria-invalid={!name.trim()}
            />
          </Flex>
          <TagInput tags={tags} onChange={setTags} suggestions={suggestions} disabled={saving} />
          <Flex gap="2" justify="flex-end">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              キャンセル
            </Button>
            <Button onClick={save} disabled={!name.trim()} loading={saving}>
              保存
            </Button>
          </Flex>
        </Flex>
      </Card.Body>
    </Card.Root>
  )
}

export default function EditSoundPanel() {
  const [editingId, setEditingId] = useAtom(editingSoundIdAtom)
  const guildSounds = useAtomValue(soundsAtom)
  const mine = useAtomValue(mySoundsAtom)
  if (!editingId) return null
  const all = [...guildSounds, ...mine]
  const sound = all.find((s) => s.id === editingId)
  if (!sound) return null // 編集中に削除された
  const suggestions = collectTags(all).map((t) => t.tag)
  // key: 別のサウンドに切り替えたら入力を作り直す
  return <Editor key={sound.id} sound={sound} suggestions={suggestions} onClose={() => setEditingId(null)} />
}
