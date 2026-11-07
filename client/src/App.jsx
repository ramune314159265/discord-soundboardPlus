import { Box, Button, Container, Flex, Heading, Spinner, Text } from '@chakra-ui/react'
import { useAtomValue } from 'jotai'
import { appStatusAtom, botHereAtom, connectionAtom, webCallableAtom, webControlsAtom, webTargetsAtom } from './state.js'
import BotGate from './components/BotGate.jsx'
import SoundGrid from './components/SoundGrid.jsx'
import NowPlayingPanel from './components/NowPlayingPanel.jsx'
import AddSoundPanel from './components/AddSoundPanel.jsx'
import GuildBadge from './components/GuildBadge.jsx'
import PipOverlay from './components/PipOverlay.jsx'
import Toast from './components/Toast.jsx'

function Centered({ children }) {
  return (
    <Flex minH="100vh" align="center" justify="center" direction="column" gap="4" p="6" textAlign="center">
      {children}
    </Flex>
  )
}

function ConnectionDot() {
  const connection = useAtomValue(connectionAtom)
  const color = connection === 'open' ? 'green.solid' : 'orange.solid'
  const label = connection === 'open' ? '接続中' : '再接続中…'
  return (
    <Flex align="center" gap="2" fontSize="xs" color="fg.muted" flexShrink="0" whiteSpace="nowrap">
      <Box w="8px" h="8px" borderRadius="full" bg={color} />
      {label}
    </Flex>
  )
}

function WebScreen({ status }) {
  const targets = useAtomValue(webTargetsAtom)
  const controls = useAtomValue(webControlsAtom)
  const callable = useAtomValue(webCallableAtom)

  if (status === 'login') {
    return (
      <Centered>
        <Heading size="md">🔊 サウンドボード</Heading>
        <Text color="fg.muted" maxW="420px">
          Discordでログインすると、ボットのいる通話に参加している間、このブラウザから音を鳴らせます。
        </Text>
        <Button asChild>
          <a href="/auth/login">Discordでログイン</a>
        </Button>
      </Centered>
    )
  }

  if (status === 'choose') {
    return (
      <Centered>
        <Heading size="md">どの通話で鳴らしますか?</Heading>
        <Flex direction="column" gap="2" w="100%" maxW="360px">
          {targets.map((t) => (
            <Button key={`${t.guildId}:${t.channelId}`} variant="outline" onClick={() => controls?.choose(t)}>
              {t.name} / {t.channelName}
            </Button>
          ))}
        </Flex>
      </Centered>
    )
  }

  return (
    <Centered>
      <Heading size="md">{callable.length > 0 ? 'ボットを通話に呼べます' : '通話に入るのを待っています'}</Heading>
      <Text color="fg.muted" maxW="420px">
        {callable.length > 0
          ? '参加している通話にボットを呼ぶと、自動でつながります。'
          : 'Discordの通話に参加すると、ここからボットを呼べます。ボットのいる通話に入れば、自動でつながります。'}
      </Text>
      {callable.length > 0 && (
        <Flex direction="column" gap="2" w="100%" maxW="360px">
          {callable.map((t) => (
            <Button key={`${t.guildId}:${t.channelId}`} onClick={() => controls?.callBot(t)}>
              🤖 {t.name} / {t.channelName} に呼ぶ
            </Button>
          ))}
        </Flex>
      )}
      <Spinner />
    </Centered>
  )
}

function Screen() {
  const status = useAtomValue(appStatusAtom)
  const botHere = useAtomValue(botHereAtom)

  if (status.status === 'loading') {
    return (
      <Centered>
        <Spinner size="lg" />
        <Text>{status.message}</Text>
      </Centered>
    )
  }

  if (status.status === 'login' || status.status === 'waiting' || status.status === 'choose') {
    return <WebScreen status={status.status} />
  }

  if (status.status === 'error') {
    return (
      <Centered>
        <Heading size="md">起動できませんでした</Heading>
        <Text color="fg.muted" maxW="420px">
          {status.message}
        </Text>
        <Button onClick={() => window.location.reload()}>再読み込み</Button>
      </Centered>
    )
  }

  return (
    <Container maxW="6xl" py="4">
      <Flex direction="column" gap="4">
        <Flex align="center" justify="space-between" gap="3">
          <Heading size="md" flexShrink="0">
            🔊 サウンドボード
          </Heading>
          {/* 右上: ギルドのアイコンと名前、その隣に接続状態 */}
          <Flex align="center" gap="3" minW="0">
            <GuildBadge />
            <ConnectionDot />
          </Flex>
        </Flex>

        {/* 左: 再生中の一覧 / 右: ボタン一覧。狭い画面では再生中の一覧が上に来る */}
        <Flex direction={{ base: 'column', md: 'row' }} align="flex-start" gap="4">
          {botHere && (
            <Box w={{ base: '100%', md: '280px' }} flexShrink="0" position={{ md: 'sticky' }} top={{ md: '4' }}>
              <NowPlayingPanel />
            </Box>
          )}
          <Flex direction="column" gap="4" flex="1" minW="0" w="100%">
            <BotGate />
            {botHere && <SoundGrid />}
            <AddSoundPanel />
          </Flex>
        </Flex>
      </Flex>
      <Toast />
    </Container>
  )
}

export default function App() {
  return (
    <>
      <Screen />
      <PipOverlay />
    </>
  )
}
