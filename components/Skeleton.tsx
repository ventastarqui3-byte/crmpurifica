
import React from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

export const Skeleton: React.FC<SkeletonProps> = ({ className, ...props }) => {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-slate-200/60", className)}
      {...props}
    />
  );
};

export const DashboardSkeleton = () => (
  <div className="space-y-6 animate-in fade-in duration-500">
    <div className="flex justify-between items-center">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-10 w-32 rounded-xl" />
    </div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <Skeleton className="h-32 rounded-[2.5rem]" />
      <Skeleton className="h-32 rounded-[2.5rem]" />
      <Skeleton className="h-32 rounded-[2.5rem]" />
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
      <div className="lg:col-span-3 space-y-8">
        <Skeleton className="h-64 rounded-[3rem]" />
      </div>
      <Skeleton className="h-64 rounded-[2.5rem]" />
    </div>
  </div>
);

export const ListSkeleton = () => (
  <div className="space-y-4">
    <div className="flex justify-between items-center mb-6">
      <Skeleton className="h-8 w-48" />
      <div className="flex gap-2">
        <Skeleton className="h-10 w-32 rounded-xl" />
        <Skeleton className="h-10 w-32 rounded-xl" />
      </div>
    </div>
    {[...Array(5)].map((_, i) => (
      <Skeleton key={i} className="h-20 w-full rounded-2xl" />
    ))}
  </div>
);
