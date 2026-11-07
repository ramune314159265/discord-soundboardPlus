import { Box, Text } from '@chakra-ui/react'
import { useAtomValue } from 'jotai'
import { isPipAtom } from '../state.js'

/**
 * ミニフローティングウィンドウ(PiP)のときは、そのままではクリックしても操作できないため、
 * ダブルクリックするよう案内する。操作そのものは Discord 側が受け取るので、ここでは表示だけ行う。
 */
export default function PipOverlay() {
  const isPip = useAtomValue(isPipAtom)
  if (!isPip) return null

  return (
    <Box
      role="status"
      position="fixed"
      inset="0"
      zIndex="overlay"
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap="2"
      p="3"
      textAlign="center"
      bg="bg"
      pointerEvents="none"
      userSelect="none"
    >
      <Text fontSize="clamp(20px, 9vw, 36px)" lineHeight="1" aria-hidden="true">
        🔊
      </Text>
      <Text fontSize="clamp(11px, 4.2vw, 18px)" fontWeight="semibold" lineHeight="1.4">
        操作するにはダブルクリックしてください
      </Text>
    </Box>
  )
}
