import { Box, Button, Flex, Input, Text } from '@chakra-ui/react'
import { lastGrapheme } from '../addSounds.js'
import TagInput from './TagInput.jsx'

/** 行ごとの進捗・結果の表示。pending (状態なし) のときは何も出さない */
function statusLabel(status) {
  switch (status?.state) {
    case 'converting':
      return status.phase === 'decoding' ? '読み込み中…' : `変換中 ${Math.round((status.ratio ?? 0) * 100)}%`
    case 'uploading':
      return 'アップロード中…'
    case 'done':
      return '✓ 追加しました'
    default:
      return ''
  }
}

/**
 * 選択したファイルごとの「絵文字」と「名前」の入力欄。表示と入力だけを担当する。
 *
 * @param {{
 *   drafts: { id: string, file: File, emoji: string, name: string, tags?: string[] }[],
 *   suggestions?: string[],
 *   statuses: Record<string, { state: string, phase?: string, ratio?: number, message?: string }>,
 *   disabled?: boolean,
 *   onChange: (id: string, patch: { emoji?: string, name?: string, tags?: string[] }) => void,
 *   onRemove: (id: string) => void,
 * }} props
 */
export default function SoundDraftList({ drafts, statuses, disabled = false, suggestions = [], onChange, onRemove }) {
  return (
    <Flex direction="column" gap="2" maxH="50vh" overflowY="auto" role="list">
      {drafts.map((draft) => {
        const status = statuses[draft.id]
        const label = statusLabel(status)
        const empty = !draft.name.trim()
        return (
          <Box key={draft.id} role="listitem" borderWidth="1px" borderRadius="md" p="3">
            <Flex align="center" justify="space-between" gap="2" mb="2">
              <Text fontSize="xs" color="fg.muted" lineClamp={1} title={draft.file.name}>
                {draft.file.name}
              </Text>
              <Flex align="center" gap="2" flexShrink="0">
                {label && (
                  <Text fontSize="xs" color={status.state === 'done' ? 'fg.success' : 'fg.muted'} whiteSpace="nowrap">
                    {label}
                  </Text>
                )}
                <Button
                  size="2xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onRemove(draft.id)}
                  aria-label={`${draft.file.name} を一覧から外す`}
                >
                  ✕
                </Button>
              </Flex>
            </Flex>

            <Flex gap="2">
              <Input
                value={draft.emoji}
                onChange={(e) => onChange(draft.id, { emoji: lastGrapheme(e.target.value) })}
                placeholder="🎉"
                w="72px"
                flexShrink="0"
                textAlign="center"
                disabled={disabled}
                aria-label={`${draft.file.name} の絵文字`}
              />
              <Input
                value={draft.name}
                onChange={(e) => onChange(draft.id, { name: e.target.value })}
                placeholder="サウンド名"
                maxLength={40}
                disabled={disabled}
                aria-label={`${draft.file.name} のサウンド名`}
                aria-invalid={empty}
              />
            </Flex>

            <Box mt="2">
              <TagInput
                tags={draft.tags ?? []}
                onChange={(tags) => onChange(draft.id, { tags })}
                suggestions={suggestions}
                disabled={disabled}
                label={`${draft.file.name} のタグ`}
              />
            </Box>

            {status?.state === 'error' && (
              <Text mt="2" fontSize="xs" color="fg.error" role="alert">
                {status.message}
              </Text>
            )}
          </Box>
        )
      })}
    </Flex>
  )
}
