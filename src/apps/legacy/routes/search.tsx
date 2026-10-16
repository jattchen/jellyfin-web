import type { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import React, { type FC, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import EmbeddingVideoSearchSection from 'apps/legacy/features/embeddingVideoSearch/EmbeddingVideoSearchSection';
import { segmentCopy } from 'apps/legacy/features/embeddingVideoSearch/copy';
import SearchFields from 'apps/legacy/features/search/components/SearchFields';
import SearchResults from 'apps/legacy/features/search/components/SearchResults';
import SearchSuggestions from 'apps/legacy/features/search/components/SearchSuggestions';
import Page from 'components/Page';
import useSearchParam from 'hooks/useSearchParam';
import globalize, { getCurrentLocale } from 'lib/globalize';

const COLLECTION_TYPE_PARAM = 'collectionType';
const PARENT_ID_PARAM = 'parentId';
const QUERY_PARAM = 'query';

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
            {!query.trim() ? (
                <SearchSuggestions
                    parentId={parentIdQuery}
                />
            ) : (
                <section className='embeddingNameSearch' aria-labelledby='embedding-name-search-title'>
                    <h2 id='embedding-name-search-title' className='sectionTitle sectionTitle-cards padded-left padded-right'>
                        {copy.nameSearch}
                    </h2>
                    <SearchResults
                        parentId={parentIdQuery}
                        collectionType={collectionTypeQuery}
                        query={query}
                    />
                </section>
            )}
            <EmbeddingVideoSearchSection
                query={query}
                draft={draft}
                parentId={parentIdQuery}
            />
        </Page>
    );
};

export default Search;
