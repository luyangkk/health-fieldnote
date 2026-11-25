import * as React from 'react'
import {Slot} from '@radix-ui/react-slot'
import {cva} from 'class-variance-authority'
import {cn} from '../../lib'
export const buttonVariants=cva('ui-button',{variants:{variant:{default:'btn-primary',outline:'btn-outline',ghost:'btn-ghost',soft:'btn-soft',danger:'btn-danger'},size:{default:'btn-md',sm:'btn-sm',icon:'btn-icon'}},defaultVariants:{variant:'default',size:'default'}})
export function Button({className,variant,size,asChild=false,...props}){const Comp=asChild?Slot:'button';return <Comp data-slot="button" className={cn(buttonVariants({variant,size,className}))} {...props}/>}
