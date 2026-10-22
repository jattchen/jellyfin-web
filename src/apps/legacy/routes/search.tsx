import type { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import React, { type FC, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import EmbeddingVideoSearchSection from 'apps/legacy/features/embeddingVideoSearch/EmbeddingVideoSearchSection';
import { segmentCopy } from 'apps/legacy/features/embeddingVideoSearch/copy';
import { useSearchItems } from 'apps/legacy/features/search/api/useSearchItems';
import SearchFields from 'apps/legacy/features/search/components/SearchFields';
import SearchResults from 'apps/legacy/features/search/components/SearchResults';
import SearchSuggestions from 'apps/legacy/features/search/components/SearchSuggestions';
import Page from 'components/Page';
import useSearchParam from 'hooks/useSearchParam';
import globalize, { getCurrentLocale } from 'lib/globalize';

const COLLECTION_TYPE_PARAM = 'collectionType';
const PARENT_ID_PARAM = 'parentId';
const QUERY_PARAM = 'query';

interface NameMatchesProps {
    parentId?: string
    collectionType?: CollectionType
    query: string
    title: string
}

/** Title search stays official, but only takes space when it found something. */
const NameMatches: FC<NameMatchesProps> = ({ parentId, collectionType, query, title }) => {
    const { data, isPending } = useSearchItems(parentId, collectionType, query.trim());
    if (isPending) {
        return null;
    }

    if (!data?.length) {
        if (!collectionType) {
            return null;
        }

        return (
            <p className='evsNameEmpty padded-left padded-right'>
                {globalize.translate('SearchResultsEmpty', query)}{' '}
                <Link className='button-link' to={`/search?query=${encodeURIComponent(query)}`}>
                    {globalize.translate('RetryWithGlobalSearch')}
                </Link>
            </p>
        );
    }

    return (
        <section className='evsNameSearch' aria-labelledby='embedding-name-search-title'>
            <h2 id='embedding-name-search-title' className='sectionTitle sectionTitle-cards padded-left padded-right'>
                {title}
            </h2>
            <SearchResults
                parentId={parentId}
                collectionType={collectionType}
                query={query}
            />
        </section>
    );
};

const Search: FC = () => {
    const [searchParams] = useSearchParams();
    const parentIdQuery = searchParams.get(PARENT_ID_PARAM) || undefined;
    const collectionTypeQuery = (searchParams.get(COLLECTION_TYPE_PARAM) || undefined) as CollectionType | undefined;
    const [ query, setQuery ] = useSearchParam(QUERY_PARAM);
    const [ draft, setDraft ] = useState(query);
    useEffect(() => {
        setDraft(query);
    }, [query]);
    const copy = segmentCopy(getCurrentLocale());
    const submitSearch = useCallback((value: string) => {
        const submitted = value.trim();
        setDraft(submitted);
        setQuery(submitted);
    }, [setQuery]);

    return (
        <Page
            id='searchPage'
            title={globalize.translate('Search')}
            className='mainAnimatedPage libraryPage allLibraryPage noSecondaryNavPage'
        >
            <SearchFields
                query={draft}
                onSearch={setDraft}
                onSubmit={submitSearch}
                submitLabel={copy.searchAction}
            />
            {!query.trim() && (
                <SearchSuggestions
                    parentId={parentIdQuery}
                />
            )}
            <EmbeddingVideoSearchSection
                query={query}
                draft={draft}
                parentId={parentIdQuery}
            />
            {query.trim() && (
                <NameMatches
                    parentId={parentIdQuery}
                    collectionType={collectionTypeQuery}
                    query={query}
                    title={copy.nameSearch}
                />
            )}
        </Page>
    );
};

export default Search;
