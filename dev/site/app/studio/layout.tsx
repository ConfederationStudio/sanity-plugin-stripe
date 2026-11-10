import type {ReactNode} from 'react'

/** The Studio's own page, without the shop's styles and header. */
export default function StudioLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <body style={{margin: 0}}>{children}</body>
    </html>
  )
}
