import {cn} from '../../lib'
export function Card({className,...props}){return <section data-slot="card" className={cn('ui-card',className)} {...props}/>}
export function Badge({className,...props}){return <span data-slot="badge" className={cn('ui-badge',className)} {...props}/>}
