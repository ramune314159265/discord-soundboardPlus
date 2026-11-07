import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, Flex, Heading, Progress, Text } from '@chakra-ui/react'
import { useAtomValue } from 'jotai'
import { mySoundsAtom, nowPlayingAtom, soundsAtom } from '../state.js'
import { requestStop, requestStopAll } from '../socket.js'
import { formatRemaining, progressOf, sortByEndLatestFirst } from '../nowPlaying.js'

const TICK_MS = 100

/** 鳴っている間だけ、一定間隔で現在時刻を更新する (進捗バーを動かすため) */
function useNow(active) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * 再生中の音の一覧。流し終わるのが後のものが上。1つずつ、またはまとめて止められる。
 * 同じサウンドを重ねていれば、その分だけ行が並ぶ。
 */
export default function NowPlayingPanel() {
  const nowPlaying = useAtomValue(nowPlayingAtom)
  const guildSounds = useAtomValue(soundsAtom)
  const mySounds = useAtomValue(mySoundsAtom)
  const now = useNow(nowPlaying.length > 0)
  const byId = useMemo(
    () => new Map([...guildSounds, ...mySounds].map((s) => [s.id, s])), // 自分だけのサウンドも自分には名前が出る
    [guildSounds, mySounds],
  )
  const ordered = useMemo(() => sortByEndLatestFirst(nowPlaying), [nowPlaying])

  return (
    <Card.Root size="sm" aria-label="再生中の音声">
      <Card.Header>
        <Flex align="center" justify="space-between" gap="2">
          <Flex align="center" gap="2">
            <Heading size="sm">再生中</Heading>
            <Badge colorPalette={nowPlaying.length > 0 ? 'green' : 'gray'}>{nowPlaying.length}</Badge>
          </Flex>
          <Button
            size="xs"
            variant="outline"
            colorPalette="red"
            disabled={nowPlaying.length === 0}
            onClick={requestStopAll}
          >
            すべて停止
          </Button>
        </Flex>
      </Card.Header>
      {/* 再生数で高さが変わらないよう、本体は固定の高さ。多いときは中でスクロールする */}
      <Card.Body h="280px" overflowY="auto">
        {nowPlaying.length === 0 ? (
          <Text fontSize="sm" color="fg.muted">
            再生中の音声はありません
          </Text>
        ) : (
          <Flex as="ul" direction="column" gap="3" listStyleType="none" m="0" p="0">
            {ordered.map((playing) => {
              const sound = byId.get(playing.soundId)
              const name = sound?.name ?? '(不明なサウンド)'
              const { ratio, remainingMs } = progressOf(playing, now)
              return (
                <Flex as="li" key={playing.id} direction="column" gap="1">
                  <Flex align="center" justify="space-between" gap="2">
                    <Flex align="center" gap="2" minW="0">
                      <Text aria-hidden="true">{sound?.emoji || '🔊'}</Text>
                      <Text fontSize="sm" lineClamp={1} title={name}>
                        {name}
                      </Text>
                    </Flex>
                    <Button
                      size="xs"
                      variant="subtle"
                      colorPalette="red"
                      flexShrink="0"
                      onClick={() => requestStop(playing.id)}
                      aria-label={`${name} を停止`}
                    >
                      ⏹ 停止
                    </Button>
                  </Flex>
                  <Flex align="center" gap="2">
                    {/* 長さが分からない音は、動き続けるバー (indeterminate) にする */}
                    <Progress.Root
                      value={ratio === null ? null : Math.round(ratio * 1000) / 10}
                      size="xs"
                      colorPalette="green"
                      flex="1"
                    >
                      <Progress.Track aria-label={`${name} の再生位置`}>
                        <Progress.Range />
                      </Progress.Track>
                    </Progress.Root>
                    <Text fontSize="xs" color="fg.muted" minW="9" textAlign="right" aria-hidden="true">
                      {formatRemaining(remainingMs)}
                    </Text>
                  </Flex>
                </Flex>
              )
            })}
          </Flex>
        )}
      </Card.Body>
    </Card.Root>
  )
}
