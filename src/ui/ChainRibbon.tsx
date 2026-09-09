import { useEffect, useRef } from 'react'
import type { CountryIndex, RegionChain } from '../data/load'

interface ChainRibbonProps {
  chain: RegionChain
  /** The country to spotlight — its stop enlarges and scrolls into view. */
  highlight?: string
  index: CountryIndex
}

/**
 * A region chain drawn like a transit line: dots on a rail, one stop per
 * country, dim hollow stops for the non-sovereign gaps so the line has no
 * mysterious holes. The point is sequence — "third stop, after the two
 * French islands" is a rememberable fact about a country the map renders
 * three pixels wide. Long chains scroll sideways; the highlighted stop
 * centres itself.
 */
export function ChainRibbon({ chain, highlight, index }: ChainRibbonProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scroller = scrollRef.current
    const target = targetRef.current
    if (!scroller || !target) return
    // Manual centring rather than scrollIntoView: this sits inside study
    // screens, and scrollIntoView would happily scroll the page too.
    scroller.scrollLeft = target.offsetLeft - (scroller.clientWidth - target.clientWidth) / 2
  }, [chain, highlight])

  return (
    <div className="chain">
      <p className="chain-title">{chain.title}</p>
      <div className="chain-scroll" ref={scrollRef}>
        <div className="chain-track">
          {chain.stops.map((stop, i) => {
            const isTarget = !!stop.iso3 && stop.iso3 === highlight
            const name = stop.label ?? (stop.iso3 ? (index.byIso3.get(stop.iso3)?.name ?? stop.iso3) : '')
            return (
              <div
                key={i}
                ref={isTarget ? targetRef : undefined}
                className={`chain-stop${isTarget ? ' is-target' : ''}${stop.iso3 ? '' : ' is-context'}`}
              >
                <span className="chain-dot" />
                <span className="chain-name">{name}</span>
              </div>
            )
          })}
        </div>
      </div>
      {chain.mnemonic && <p className="chain-mnemonic">{chain.mnemonic}</p>}
    </div>
  )
}
