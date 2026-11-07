import { useEffect, useRef, useState } from 'react'
import { Box, Button, Card, Flex, SimpleGrid, Tabs, Text } from '@chakra-ui/react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  editingSoundIdAtom,
  mySoundsAtom,
  playingSoundIdsAtom,
  selectedTagsAtom,
  sessionAtom,
  soundTabAtom,
  soundsAtom,
  tabSoundsAtom,
  toastAtom,
} from '../state.js'
import { filterByTags } from '../soundList.js'
import TagFilter from './TagFilter.jsx'
import EditSoundPanel from './EditSoundPanel.jsx'
import { requestPlay } from '../socket.js'

function DeleteButton({ onConfirm }) {
  const [armed, setArmed] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  // iframe 内では confirm() が使えないことがあるので、2回押しで確定する
  const click = (event) => {
    event.stopPropagation()
    if (armed) {
      clearTimeout(timer.current)
      setArmed(false)
      onConfirm()
      return
    }
    setArmed(true)
    timer.current = setTimeout(() => setArmed(false), 3000)
  }

  return (
    <Button
      size="2xs"
      position="absolute"
      top="1"
      right="1"
      minW="6"
      px={armed ? '2' : '0'}
      variant={armed ? 'solid' : 'ghost'}
      colorPalette="red"
      onClick={click}
      aria-label={armed ? 'もう一度押すと削除' : '削除'}
    >
      {armed ? '削除?' : '✕'}
    </Button>
  )
}

function EditButton({ name, onClick }) {
  return (
    <Button
      size="2xs"
      position="absolute"
      top="1"
      left="1"
      minW="6"
      px="0"
      variant="ghost"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      aria-label={`${name} を編集`}
    >
      ✎
    </Button>
  )
}

function SoundButton({ sound, playing, onDelete, onEdit }) {
  return (
    <Box position="relative">
      <Button
        onClick={() => requestPlay(sound.id)}
        h="88px"
        w="100%"
        display="flex"
        flexDirection="column"
        gap="1"
        px="2"
        variant="outline"
        colorPalette={playing ? 'green' : 'gray'}
        borderWidth="3px"
        aria-pressed={playing}
      >
        <Text fontSize="2xl" lineHeight="1">
          {sound.emoji || '🔊'}
        </Text>
        <Text fontSize="sm" lineClamp={1} maxW="100%" fontWeight="medium">
          {sound.name}
        </Text>
      </Button>
      <EditButton name={sound.name} onClick={onEdit} />
      <DeleteButton onConfirm={onDelete} />
    </Box>
  )
}

function Tabbar() {
  const [tab, setTab] = useAtom(soundTabAtom)
  const setSelected = useSetAtom(selectedTagsAtom)
  const guildCount = useAtomValue(soundsAtom).length
  const mineCount = useAtomValue(mySoundsAtom).length
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(e) => {
        setTab(e.value)
        setSelected([]) // タブごとにタグが違うので、絞り込みは持ち越さない
      }}
      size="sm"
    >
      <Tabs.List>
        <Tabs.Trigger value="guild">このサーバー ({guildCount})</Tabs.Trigger>
        <Tabs.Trigger value="mine">自分が追加 ({mineCount})</Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  )
}

export default function SoundGrid() {
  const tab = useAtomValue(soundTabAtom)
  const tabSounds = useAtomValue(tabSoundsAtom)
  const selected = useAtomValue(selectedTagsAtom)
  const playingIds = useAtomValue(playingSoundIdsAtom)
  const session = useAtomValue(sessionAtom)
  const setToast = useSetAtom(toastAtom)
  const setEditing = useSetAtom(editingSoundIdAtom)

  const sounds = filterByTags(tabSounds, selected)

  const remove = async (id) => {
    try {
      await session.api.deleteSound(id)
    } catch (err) {
      setToast({ kind: 'error', text: err.message })
    }
  }

  let empty = null
  if (tabSounds.length === 0) {
    empty = tab === 'mine' ? 'まだ自分が追加したサウンドがありません。' : 'まだサウンドがありません。下の「音声を追加」から登録してください。'
  } else if (sounds.length === 0) {
    empty = '選んだタグをすべて持つサウンドはありません。'
  }

  return (
    <Flex direction="column" gap="3">
      <Tabbar />
      <EditSoundPanel />
      <TagFilter />
      {empty ? (
        <Card.Root>
          <Card.Body textAlign="center" color="fg.muted" fontSize="sm">
            {empty}
          </Card.Body>
        </Card.Root>
      ) : (
        <SimpleGrid minChildWidth="130px" gap="3">
          {sounds.map((sound) => (
            <SoundButton
              key={sound.id}
              sound={sound}
              playing={playingIds.has(sound.id)}
              onDelete={() => remove(sound.id)}
              onEdit={() => setEditing(sound.id)}
            />
          ))}
        </SimpleGrid>
      )}
    </Flex>
  )
}
