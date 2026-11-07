import { useEffect, useState } from 'react'
import { Flex, Text } from '@chakra-ui/react'
import { useAtomValue } from 'jotai'
import { guildAtom } from '../state.js'

const SIZE = 24

/** ギルドのアイコン(無い/読み込めない場合は頭文字)と名前 */
export default function GuildBadge() {
  const guild = useAtomValue(guildAtom)
  const [imageFailed, setImageFailed] = useState(false)

  // 別のアイコンに変わったら読み込みをやり直す
  useEffect(() => setImageFailed(false), [guild?.iconUrl])

  if (!guild) return null
  const initial = [...(guild.name || '?')][0].toUpperCase()

  return (
    <Flex align="center" gap="2" minW="0" title={guild.name}>
      {guild.iconUrl && !imageFailed ? (
        <img
          src={guild.iconUrl}
          alt=""
          width={SIZE}
          height={SIZE}
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          style={{ width: SIZE, height: SIZE, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        />
      ) : (
        <Flex
          align="center"
          justify="center"
          flexShrink="0"
          borderRadius="full"
          bg="bg.emphasized"
          fontSize="xs"
          fontWeight="bold"
          style={{ width: SIZE, height: SIZE }}
          aria-hidden="true"
        >
          {initial}
        </Flex>
      )}
      <Text fontSize="sm" fontWeight="medium" lineClamp={1} maxW={{ base: '110px', sm: '220px' }}>
        {guild.name}
      </Text>
    </Flex>
  )
}

