import type { ComponentProps, FC } from 'react';
import { CaretLeftIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { cn } from '@conservationtv/ui/lib/utils';

// A page's parts, composed where they're used. Every page under the organisation layout is a Page: a centred column
// with a header (its title, a line about it, and its actions) over its sections.
//
//   <Page>
//     <PageHeader>
//       <PageHeading>
//         <PageTitle>Networks</PageTitle>
//         <PageDescription>The sites your cameras and agents are on.</PageDescription>
//       </PageHeading>
//       <PageActions>…</PageActions>
//     </PageHeader>
//     <Section>
//       <SectionHeader>
//         <SectionTitle>…</SectionTitle>
//       </SectionHeader>
//       …
//     </Section>
//   </Page>

/** The page's column. Lists and forms read best narrow (`max-w-3xl`, the default); pass a wider class for grids. */
export const Page: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-8 px-10 py-10', className)} {...props} />;
};

/**
 * The way back from a detail page to the list it belongs to, above its header, named for where it goes:
 * `<BackLink to=".." relative="path">Streams</BackLink>`.
 */
export const BackLink: FC<ComponentProps<typeof Link>> = ({ className, children, ...props }) => {
  return (
    <Link
      className={cn(
        '-mb-4 inline-flex w-fit items-center gap-1 text-custom-13 text-custom-text-secondary hover:text-foreground',
        className
      )}
      {...props}
    >
      <CaretLeftIcon className="size-3" aria-hidden="true" />
      {children}
    </Link>
  );
};

/** The heading on the left, the actions on the right, level with the title. */
export const PageHeader: FC<ComponentProps<'header'>> = ({ className, ...props }) => {
  return <header className={cn('flex items-start justify-between gap-6', className)} {...props} />;
};

export const PageHeading: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('flex min-w-0 flex-1 flex-col gap-2', className)} {...props} />;
};

export const PageTitle: FC<ComponentProps<'h1'>> = ({ className, ...props }) => {
  return <h1 className={cn('text-custom-21 font-semibold text-foreground', className)} {...props} />;
};

export const PageDescription: FC<ComponentProps<'p'>> = ({ className, ...props }) => {
  return (
    <p
      className={cn('max-w-2xl text-custom-13 leading-(--leading-custom-body) text-custom-text-secondary', className)}
      {...props}
    />
  );
};

export const PageActions: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('flex shrink-0 flex-wrap items-center gap-2', className)} {...props} />;
};

/** One part of a page, under its own heading. */
export const Section: FC<ComponentProps<'section'>> = ({ className, ...props }) => {
  return <section className={cn('flex flex-col gap-4', className)} {...props} />;
};

/** A section's title and description on the left, anything it offers (an Add button) on the right. */
export const SectionHeader: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-2', className)} {...props} />;
};

export const SectionHeading: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('flex min-w-0 flex-col gap-1', className)} {...props} />;
};

export const SectionTitle: FC<ComponentProps<'h2'>> = ({ className, ...props }) => {
  return <h2 className={cn('text-custom-15 font-medium text-foreground', className)} {...props} />;
};

export const SectionDescription: FC<ComponentProps<'p'>> = ({ className, ...props }) => {
  return <p className={cn('max-w-2xl text-custom-13 text-custom-text-secondary', className)} {...props} />;
};

/** A label over a value, for a resource's facts: its ID, when it was made, where it is. Lay several out in a Facts. */
export const Fact: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('flex min-w-0 flex-col gap-1', className)} {...props} />;
};

export const FactLabel: FC<ComponentProps<'dt'>> = ({ className, ...props }) => {
  return <dt className={cn('text-custom-12 text-custom-text-secondary', className)} {...props} />;
};

export const FactValue: FC<ComponentProps<'dd'>> = ({ className, ...props }) => {
  return <dd className={cn('min-w-0 truncate text-custom-13 text-foreground', className)} {...props} />;
};

/** Facts, as many to a row as fit. */
export const Facts: FC<ComponentProps<'dl'>> = ({ className, ...props }) => {
  return (
    <dl
      className={cn('grid grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-x-8 gap-y-5', className)}
      {...props}
    />
  );
};
