import { useEffect } from 'react'
import { Box } from '@chakra-ui/react'
import { useAtom } from 'jotai'
import { toastAtom } from '../state.js'

export default function Toast() {
  const [toast, setToast] = useAtom(toastAtom)

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast, setToast])

  if (!toast) return null
  return (
    <Box
      position="fixed"
      bottom="4"
      left="50%"
      transform="translateX(-50%)"
      maxW="90vw"
      px="4"
      py="2"
      borderRadius="md"
      bg={toast.kind === 'error' ? 'red.solid' : 'bg.inverted'}
      color={toast.kind === 'error' ? 'red.contrast' : 'fg.inverted'}
      fontSize="sm"
      boxShadow="lg"
      zIndex="toast"
      role="status"
    >
      {toast.text}
    </Box>
  )
}
