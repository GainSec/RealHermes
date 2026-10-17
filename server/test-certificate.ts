import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'

// Test utility: a throwaway self-signed ECDSA P-256 certificate for one hostname, generated in memory for each test
// run, so the repository never stores a private key. Encodes just the X.509 fields TLS hostname checks need.
function der(tag: number, ...parts: Buffer[]) {
  const body = Buffer.concat(parts)
  const length = body.length < 0x80 ? Buffer.from([body.length]) : body.length < 0x100 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff])
  return Buffer.concat([Buffer.from([tag]), length, body])
}
const sequence = (...parts: Buffer[]) => der(0x30, ...parts)
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'))
// UTCTime through 2049, GeneralizedTime after (RFC 5280).
function time(date: Date) {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(digits.slice(2))) : der(0x18, Buffer.from(digits))
}
export function selfSignedCertificate(hostname: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const ecdsaWithSha256 = sequence(oid('2a8648ce3d040302'))
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from(hostname)))))
  // A positive serial with no leading zero byte, as DER requires.
  const serial = randomBytes(8); serial[0] = (serial[0] & 0x7f) | 0x01
  const now = Date.now()
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ecdsaWithSha256,
    name,
    sequence(time(new Date(now - 86_400_000)), time(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      // basicConstraints (critical, CA) so the certificate can be its own trust anchor.
      sequence(oid('551d13'), der(0x01, Buffer.from([0xff])), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
      // subjectAltName dNSName: the name TLS hostname verification checks.
      sequence(oid('551d11'), der(0x04, sequence(der(0x82, Buffer.from(hostname))))),
    )),
  )
  const certificate = sequence(tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)))
  const body = certificate.toString('base64').match(/.{1,64}/g)!.join('\n')
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n` }
}
