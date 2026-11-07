import { useState } from 'react'
import { Button, Card, Flex, Text } from '@chakra-ui/react'
import { useAtomValue, useSetAtom } from 'jotai'
import { botChannelIdAtom, botHereAtom, sessionAtom, toastAtom } from '../state.js'

/** ボットの在席状況。いなければ参加ボタン、別の通話にいれば移動ボタン、いれば退出ボタンを出す */
export default function BotGate() {
  const session = useAtomValue(sessionAtom)
  const botChannelId = useAtomValue(botChannelIdAtom)
  const botHere = useAtomValue(botHereAtom)
  const setToast = useSetAtom(toastAtom)
  const [busy, setBusy] = useState(false)

  const run = async (action) => {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setToast({ kind: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  const join = () => run(() => session.api.joinBot(session.channelId))
  const leave = () => run(() => session.api.leaveBot())

  // ブラウザ(アクティビティ外)からは、ボットの参加・退出はさせない (通話に入っている人だけが鳴らす)
  if (session?.web) {
    return (
      <Text fontSize="sm" color="fg.muted">
        {botHere ? 'ボットのいる通話に参加中です。ここから音を鳴らせます' : 'ボットがこの通話からいなくなりました。待機中…'}
      </Text>
    )
  }

  if (botHere) {
    return (
      <Flex align="center" justify="space-between" fontSize="sm" color="fg.muted">
        <Text>ボットがこの通話に参加しています</Text>
        <Button size="xs" variant="ghost" onClick={leave} loading={busy}>
          退出させる
        </Button>
      </Flex>
    )
  }

  const elsewhere = botChannelId !== null
  return (
    <Card.Root>
      <Card.Body alignItems="center" textAlign="center" gap="1">
        <Text fontWeight="semibold">{elsewhere ? 'ボットは別の通話に参加しています' : 'この通話にボットがいません'}</Text>
        <Text mb="3" fontSize="sm" color="fg.muted">
          サウンドを流すには、ボットをこの通話に参加させてください。
        </Text>
        <Button onClick={join} loading={busy} loadingText="接続中…">
          {elsewhere ? 'ボットをこの通話に移動' : 'ボットを通話に参加させる'}
        </Button>
      </Card.Body>
    </Card.Root>
  )
}
