import { useRef, useState } from 'react'
import { Box, Button, Card, Flex, Progress, Text } from '@chakra-ui/react'
import { useAtomValue, useSetAtom } from 'jotai'
import { limitsAtom, mySoundsAtom, sessionAtom, soundTabAtom, soundsAtom, toastAtom } from '../state.js'
import { collectTags } from '../soundList.js'
import { convertToOggOpus } from '../audio/convert.js'
import { createDrafts, runBatch } from '../addSounds.js'
import SoundDraftList from './SoundDraftList.jsx'

export default function AddSoundPanel() {
  const session = useAtomValue(sessionAtom)
  const limits = useAtomValue(limitsAtom)
  const setToast = useSetAtom(toastAtom)
  const personal = useAtomValue(soundTabAtom) === 'mine' // 「自分が追加」タブから追加するときは、サーバーに属さず自分だけのサウンドにする
  const guildSounds = useAtomValue(soundsAtom)
  const mySounds = useAtomValue(mySoundsAtom)
  const suggestions = collectTags([...guildSounds, ...mySounds]).map((t) => t.tag)

  const [open, setOpen] = useState(false)
  /** 選択中のファイルごとの入力 (絵文字・名前) */
  const [drafts, setDrafts] = useState([])
  /** 下書きIDごとの進捗・結果 */
  const [statuses, setStatuses] = useState({})
  const [dragging, setDragging] = useState(false)
  const [running, setRunning] = useState(false)
  const inputRef = useRef(null)
  const abortRef = useRef(null)

  const allNamed = drafts.every((d) => d.name.trim())
  const canSubmit = drafts.length > 0 && allNamed && !running

  /** ファイルを選び直したら、それまでの選択は破棄して置き換える (追加はしない) */
  const pick = (fileList) => {
    const files = Array.from(fileList ?? []) // input.value を空にする前にコピーしておく
    if (inputRef.current) inputRef.current.value = ''
    if (files.length === 0) return // 選択をキャンセルしたときは、今の選択をそのまま残す
    setDrafts(createDrafts(files))
    setStatuses({})
  }

  const reset = () => {
    setDrafts([])
    setStatuses({})
    setRunning(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const updateDraft = (id, patch) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)))
    // 直したら、前回のエラー表示は消す
    setStatuses((prev) => {
      if (prev[id]?.state !== 'error') return prev
      const { [id]: _removed, ...rest } = prev
      return rest
    })
  }

  const removeDraft = (id) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id))
    setStatuses((prev) => {
      const { [id]: _removed, ...rest } = prev
      return rest
    })
  }

  const submit = async () => {
    if (!canSubmit) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)

    const result = await runBatch({
      drafts,
      convert: convertToOggOpus,
      upload: (input) => session.api.uploadSound({ ...input, personal }),
      onStatus: (id, status) => {
        if (!controller.signal.aborted) setStatuses((prev) => ({ ...prev, [id]: status }))
      },
      signal: controller.signal,
      maxUploadBytes: limits.maxUploadBytes,
    })
    abortRef.current = null
    if (result.aborted) return // キャンセル済み (cancel() が画面を片付けている)

    setRunning(false)
    const added = result.succeeded.length
    if (result.failed.length === 0) {
      const text = added === 1 ? `「${drafts[0].name.trim()}」を追加しました` : `${added}件のサウンドを追加しました`
      setToast({ kind: 'info', text })
      reset()
      setOpen(false)
      return
    }

    // 一部失敗: 成功したものは一覧から外し、失敗したものだけ残して、直して再実行できるようにする
    const succeeded = new Set(result.succeeded)
    const failedIds = new Set(result.failed.map((f) => f.id))
    setDrafts((prev) => prev.filter((d) => !succeeded.has(d.id)))
    setStatuses((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => failedIds.has(id))))
    setToast({
      kind: 'error',
      text: added > 0 ? `${added}件を追加、${result.failed.length}件は失敗しました` : `${result.failed.length}件の追加に失敗しました`,
    })
  }

  const cancel = () => {
    abortRef.current?.abort()
    reset()
    setOpen(false)
  }

  if (!open) {
    return (
      <Button alignSelf="flex-start" variant="outline" onClick={() => setOpen(true)}>
        ＋ 音声を追加
      </Button>
    )
  }

  const finished = drafts.filter((d) => statuses[d.id]?.state === 'done' || statuses[d.id]?.state === 'error').length
  const barPercent = drafts.length > 0 ? Math.round((finished / drafts.length) * 100) : 0

  return (
    <Card.Root>
      <Card.Body>
      <Flex direction="column" gap="3">
        <Text fontSize="sm" color="fg.muted">
          {personal ? '自分だけのサウンドとして追加します (サーバーには追加されません)' : 'このサーバーのサウンドとして追加します'}
        </Text>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="audio/*,video/mp4,video/webm,.mp3,.wav,.ogg,.oga,.opus,.m4a,.aac,.flac,.webm"
          hidden
          onChange={(e) => pick(e.target.files)}
        />

        <Box
          border="2px dashed"
          borderColor={dragging ? 'blue.solid' : 'border'}
          borderRadius="md"
          p="5"
          textAlign="center"
          cursor={running ? 'default' : 'pointer'}
          onClick={() => !running && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (!running) pick(e.dataTransfer.files)
          }}
        >
          <Text fontSize="sm">
            {drafts.length > 0
              ? `${drafts.length}個のファイルを選択中 (クリックで選び直し)`
              : 'クリックしてファイルを選択 (複数可) / ここにドロップ'}
          </Text>
          <Text fontSize="xs" color="fg.muted" mt="1">
            {drafts.length > 0
              ? '選び直すと、今の選択は破棄されて置き換わります。'
              : 'mp3 / wav / ogg / m4a など。ファイル名を「🎺_名前.mp3」にすると、絵文字と名前が自動で入ります。'}
          </Text>
        </Box>

        {drafts.length > 0 && (
          <SoundDraftList
            drafts={drafts}
            statuses={statuses}
            disabled={running}
            suggestions={suggestions}
            onChange={updateDraft}
            onRemove={removeDraft}
          />
        )}

        {running && (
          <Box>
            <Text fontSize="sm" color="fg.muted" mb="1">
              {finished} / {drafts.length} 件 処理済み
            </Text>
            <Progress.Root value={barPercent} size="xs">
              <Progress.Track>
                <Progress.Range />
              </Progress.Track>
            </Progress.Root>
          </Box>
        )}

        {drafts.length > 0 && !allNamed && !running && (
          <Text fontSize="xs" color="fg.error">
            名前が未入力のファイルがあります。
          </Text>
        )}

        <Flex gap="2" justify="flex-end">
          <Button variant="ghost" onClick={cancel}>
            キャンセル
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            loading={running}
          >
            {drafts.length > 1 ? `${drafts.length}件を追加` : '追加'}
          </Button>
        </Flex>
      </Flex>
      </Card.Body>
    </Card.Root>
  )
}
